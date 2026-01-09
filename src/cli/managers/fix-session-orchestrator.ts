import * as clack from "@clack/prompts";
import type LocalCache from "../../cache/local-cache";
import type GitOperations from "../../git/operations";
import type { CommentFixer, FixPlan } from "../../review/comment-fixer";
import type { ReviewComment } from "../../review/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";

export class FixSessionOrchestrator {
	constructor(
		private commentFixer: CommentFixer,
		private git: GitOperations,
		private cache: LocalCache,
		private ui: UILogger,
	) {}

	public async runFixSession(
		comment: ReviewComment,
		prKey: string,
		fullDiff: string,
		userOptionalNotes: string | undefined,
		summary: {
			accepted: number;
			fixed: number;
			rejected: number;
			skipped: number;
		},
	): Promise<void> {
		console.log("");

		// PHASE 1: PLANNING
		const plan = await this.runPlanningPhase(
			comment,
			prKey,
			fullDiff,
			userOptionalNotes,
			summary,
		);

		if (!plan) {
			return; // Planning was cancelled or failed
		}

		// PHASE 2: EXECUTION
		await this.runExecutionPhase(
			comment,
			prKey,
			plan,
			fullDiff,
			userOptionalNotes,
			summary,
		);
	}

	private async runPlanningPhase(
		comment: ReviewComment,
		prKey: string,
		fullDiff: string,
		userOptionalNotes: string | undefined,
		summary: {
			accepted: number;
			fixed: number;
			rejected: number;
			skipped: number;
		},
	): Promise<FixPlan | null> {
		clack.log.info(theme.primary("📋 Phase 1: Planning"));
		console.log("");

		let plan: FixPlan | null = null;
		let planIterations = 0;
		const maxPlanIterations = 3;
		let planFeedback: string | undefined;

		while (planIterations < maxPlanIterations) {
			planIterations++;

			const spinner = this.ui.spinner();
			spinner.start(
				planIterations === 1
					? theme.accent("Claude is thinking about the fix...")
					: theme.accent(`Refining plan (iteration ${planIterations})...`),
			);

			try {
				plan = await this.commentFixer.generatePlan(comment, {
					fullDiff,
					userOptionalNotes,
					previousPlanFeedback: planFeedback,
				});

				spinner.stop(theme.success("✓ Plan ready"));

				// Show plan to user
				console.log("");
				this.displayPlan(plan);
				console.log("");

				// Get user decision on plan
				const planDecision = await clack.select({
					message: "What do you think of this plan?",
					options: [
						{
							value: "approve",
							label: "✓ Approve",
							hint: "Let Claude implement this plan",
						},
						{
							value: "refine",
							label: "🔄 Refine",
							hint: "Ask Claude to improve the plan",
						},
						{
							value: "reject",
							label: "✗ Reject",
							hint: "Cancel fix, mark as rejected",
						},
					],
				});

				if (clack.isCancel(planDecision)) {
					if (comment.id) {
						await this.cache.updateComment(prKey, comment.id, {
							status: "rejected",
						});
					}
					summary.rejected++;
					return null;
				}

				if (planDecision === "approve") {
					// Plan approved! Move to execution
					break;
				}

				if (planDecision === "reject") {
					if (comment.id) {
						await this.cache.updateComment(prKey, comment.id, {
							status: "rejected",
						});
					}
					summary.rejected++;
					clack.log.step(theme.muted("✗ Plan rejected"));
					return null;
				}

				// planDecision === 'refine'
				const feedback = await clack.text({
					message: "What should Claude change in the plan?",
					placeholder: 'e.g., "Also check for similar issues in other files"',
					validate: (value) => {
						if (!value || value.trim().length === 0) {
							return "Feedback is required for refinement";
						}
						return;
					},
				});

				if (clack.isCancel(feedback)) {
					return null;
				}

				planFeedback = (feedback as string).trim();
			} catch (error) {
				spinner.stop(theme.error("✗ Planning failed"));
				this.ui.error(`Error: ${(error as Error).message}`);

				const retry = await clack.confirm({
					message: "Try planning again?",
					initialValue: false,
				});

				if (!retry || clack.isCancel(retry)) {
					if (comment.id) {
						await this.cache.updateComment(prKey, comment.id, {
							status: "rejected",
						});
					}
					summary.rejected++;
					return null;
				}
			}
		}

		if (!plan) {
			clack.log.warn(theme.warning("Max plan iterations reached"));
			if (comment.id) {
				await this.cache.updateComment(prKey, comment.id, {
					status: "rejected",
				});
			}
			summary.rejected++;
			return null;
		}

		return plan;
	}

	private async runExecutionPhase(
		comment: ReviewComment,
		prKey: string,
		plan: FixPlan,
		fullDiff: string,
		userOptionalNotes: string | undefined,
		summary: {
			accepted: number;
			fixed: number;
			rejected: number;
			skipped: number;
		},
	): Promise<void> {
		console.log("");
		clack.log.info(theme.primary("🔧 Phase 2: Execution"));
		console.log("");

		const executionSpinner = this.ui.spinner();
		executionSpinner.start(theme.accent("Claude is implementing the plan..."));

		let lastCheckTime = Date.now();
		const checkIntervalMs = 10000; // Ask user every 10 seconds

		try {
			const result = await this.commentFixer.executePlan(
				comment,
				plan,
				{ fullDiff, userOptionalNotes },
				async (event) => {
					// Update UI based on event type
					switch (event.type) {
						case "thinking": {
							const truncated = event.message.substring(0, 60);
							executionSpinner.message(
								theme.dim(
									`💭 ${truncated}${event.message.length > 60 ? "..." : ""}`,
								),
							);
							break;
						}

						case "tool_use":
							executionSpinner.message(theme.accent(`🔧 ${event.message}`));
							this.ui.step(
								theme.muted(`[${event.toolCount}] ${event.message}`),
							);
							break;

						case "tool_result":
							executionSpinner.message(theme.secondary("Processing..."));
							break;

						case "checkpoint": {
							executionSpinner.stop();
							clack.log.info(theme.warning(`⏸️  ${event.message}`));

							const continueDecision = await clack.confirm({
								message: "Let Claude continue?",
								initialValue: true,
							});

							if (clack.isCancel(continueDecision) || !continueDecision) {
								executionSpinner.start(theme.accent("Stopping..."));
								return "stop";
							}

							executionSpinner.start(theme.accent("Continuing..."));
							return "continue";
						}
					}

					// Periodic time-based check-in
					const now = Date.now();
					if (now - lastCheckTime > checkIntervalMs) {
						lastCheckTime = now;

						executionSpinner.stop();

						const continueDecision = await clack.confirm({
							message: `Claude has made ${event.toolCount} operations. Continue?`,
							initialValue: true,
						});

						if (clack.isCancel(continueDecision) || !continueDecision) {
							return "stop";
						}

						executionSpinner.start(theme.accent("Continuing..."));
					}

					return "continue";
				},
			);

			executionSpinner.stop();

			// Handle execution failure/stop
			if (!result.success) {
				clack.log.error(theme.error("✗ Execution stopped or failed"));

				if (result.error) {
					this.ui.error(result.error);
				}

				// Show partial changes if any
				if (result.filesModified.length > 0) {
					const gitDiff = await this.getGitDiff(result.filesModified);
					console.log("");
					clack.log.info(theme.secondary("Partial changes made:"));
					console.log(theme.muted(gitDiff));
					console.log("");

					const keepPartial = await clack.confirm({
						message: "Keep partial changes?",
						initialValue: false,
					});

					if (!keepPartial || clack.isCancel(keepPartial)) {
						await this.revertChanges(result.filesModified);
						clack.log.step(theme.muted("Changes reverted"));
					}
				}

				if (comment.id) {
					await this.cache.updateComment(prKey, comment.id, {
						status: "rejected",
					});
				}
				summary.rejected++;
				return;
			}

			// Execution completed successfully
			clack.log.success(theme.success("✓ Claude completed the implementation"));

			if (result.finalThoughts) {
				console.log("");
				clack.log.step(theme.dim(result.finalThoughts));
			}

			// Show what changed
			if (result.filesModified.length > 0) {
				clack.log.info(
					theme.secondary(`Modified: ${result.filesModified.join(", ")}`),
				);

				const gitDiff = await this.getGitDiff(result.filesModified);
				console.log("");
				clack.log.info(theme.secondary("Changes:"));
				console.log(theme.muted(gitDiff));
				console.log("");
			} else {
				clack.log.warn(theme.warning("No files were modified"));
			}

			// Final approval from user
			const acceptChanges = await clack.confirm({
				message: "Accept these changes?",
				initialValue: true,
			});

			if (clack.isCancel(acceptChanges) || !acceptChanges) {
				await this.revertChanges(result.filesModified);
				if (comment.id) {
					await this.cache.updateComment(prKey, comment.id, {
						status: "rejected",
					});
				}
				summary.rejected++;
				clack.log.step(
					theme.muted("✗ Changes reverted, comment marked as rejected"),
				);
				return;
			}

			// Success! Keep changes and mark as fixed
			if (comment.id) {
				await this.cache.updateComment(prKey, comment.id, { status: "fixed" });
			}
			summary.fixed++;
			clack.log.success(
				theme.success("✓ Changes accepted, comment marked as fixed"),
			);
		} catch (error) {
			executionSpinner.stop(theme.error("✗ Execution failed"));
			this.ui.error(`Error: ${(error as Error).message}`);

			// Try to revert any changes
			try {
				const status = await this.git.status();
				const modifiedFiles = status.modified;

				if (modifiedFiles.length > 0) {
					const shouldRevert = await clack.confirm({
						message: "Revert changes made before the error?",
						initialValue: true,
					});

					if (shouldRevert && !clack.isCancel(shouldRevert)) {
						await this.revertChanges(modifiedFiles);
					}
				}
			} catch {
				// Ignore revert errors
			}

			if (comment.id) {
				await this.cache.updateComment(prKey, comment.id, {
					status: "rejected",
				});
			}
			summary.rejected++;
		}
	}

	private async getGitDiff(files: string[]): Promise<string> {
		if (files.length === 0) {
			return "No files modified";
		}

		try {
			const { exec } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execAsync = promisify(exec);

			const { stdout } = await execAsync(
				`git diff ${files.map((f) => `"${f}"`).join(" ")}`,
			);

			return stdout || "No changes detected";
		} catch (error) {
			return `Could not generate diff: ${(error as Error).message}`;
		}
	}

	private async revertChanges(files: string[]): Promise<void> {
		if (files.length === 0) return;

		const spinner = this.ui.spinner();
		spinner.start(theme.muted("Reverting changes..."));

		try {
			const { exec } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execAsync = promisify(exec);

			await execAsync(
				`git checkout -- ${files.map((f) => `"${f}"`).join(" ")}`,
			);

			spinner.stop(theme.success("✓ Changes reverted"));
		} catch (error) {
			spinner.stop(theme.error("✗ Failed to revert"));
			this.ui.error(`Revert error: ${(error as Error).message}`);
		}
	}

	private displayPlan(plan: FixPlan): void {
		clack.log.info(theme.primary("Claude's Plan:"));
		console.log("");

		clack.log.step(theme.secondary("Approach:"));
		clack.log.step(theme.dim(plan.approach));
		console.log("");

		clack.log.step(theme.secondary("Steps:"));
		plan.steps.forEach((step, i) => {
			clack.log.step(theme.dim(`  ${i + 1}. ${step}`));
		});
		console.log("");

		clack.log.step(theme.secondary("Files to modify:"));
		plan.filesAffected.forEach((file) => {
			clack.log.step(theme.dim(`  • ${file}`));
		});

		if (plan.potentialRisks.length > 0) {
			console.log("");
			clack.log.step(theme.warning("⚠️  Potential risks:"));
			plan.potentialRisks.forEach((risk) => {
				clack.log.step(theme.dim(`  • ${risk}`));
			});
		}
	}
}
