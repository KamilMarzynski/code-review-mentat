import * as clack from "@clack/prompts";
import { createHash, randomUUID } from "crypto";
import type LocalCache from "../cache/local-cache";
import type GitOperations from "../git/operations";
import type { GitProvider, PullRequest } from "../providers/types";
import type { CommentFixer, FixPlan } from "../review/comment-fixer";
import type { ReviewService } from "../review/review-service";
import {
	type ContextEvent,
	isContextEvent,
	isReviewEvent,
	type ReviewComment,
	type ReviewCommentStatus,
	type ReviewCommentWithId,
	type ReviewEvent,
} from "../review/types";
import type { UILogger } from "../ui/logger";
import { theme } from "../ui/theme";
import { displayComments, displayContext, displayHeader } from "./display";
import {
	promptForCacheStrategy,
	promptForPR,
	promptForRemote,
} from "./prompts";

enum Phase {
	INIT = "init",
	CONTEXT = "context",
	REVIEW = "review",
	COMPLETE = "complete",
}

export class CLIOrchestrator {
	constructor(
		private git: GitOperations,
		private createProvider: (remote: string) => GitProvider,
		private reviewService: ReviewService,
		private commentFixer: CommentFixer,
		private cache: LocalCache,
		private ui: UILogger,
	) {}

	public async run(): Promise<void> {
		displayHeader();
		clack.intro(theme.primary("Initiating Mentat analysis protocol..."));

		const currentBranch = await this.git.getCurrentBranch();
		const { cleanup } = this.setupCleanupHandlers(currentBranch);

		try {
			// Step 1-2: Remote selection and PR fetching
			const selectedRemote = await this.selectRemote();
			const { provider, prs } = await this.fetchPullRequests(selectedRemote);

			// Step 3: PR selection
			const selectedPr = await this.selectPullRequest(prs);

			// Step 4: Repository preparation
			await this.prepareRepository(selectedRemote, selectedPr);

			// Step 5: Changes analysis
			const { fullDiff, editedFiles } = await this.analyzeChanges(selectedPr);

			// Step 6: Commit history
			const commitMessages = await this.fetchCommitHistory(
				provider,
				selectedPr,
			);

			// Step 7: Cache strategy
			const cacheConfig = await this.determineCacheStrategy(selectedPr);

			const commentsBefore = await this.cache.getComments(
				`${selectedPr.source.name}|${selectedPr.target.name}`,
			);
			if (commentsBefore.length > 0) {
				clack.log.info(
					theme.secondary("This pull request was previously reviewed. "),
				);
				const pendingComments = commentsBefore.filter(
					(c) => c.status === "pending" || !c.status,
				);
				if (pendingComments.length > 0) {
					clack.log.info(
						theme.warning(
							`There are ${pendingComments.length} unresolved comment(s) from the last review session.`,
						),
					);

					// TODO: ask user if they want to handle comments now or maybe they want to proceed with new review etc.
					// a lot of to handle here now, it depends if there were new commits etc.
					await this.handleComments(
						`${selectedPr.source.name}|${selectedPr.target.name}`,
					);

					return;
				}
			}

			// Step 8: Process review stream
			const { contextHasError, reviewHasError } =
				await this.processReviewStream(
					selectedPr,
					commitMessages,
					fullDiff,
					editedFiles,
					cacheConfig,
				);

			console.log(""); // Spacing

			if (contextHasError || reviewHasError) {
				clack.outro(
					theme.warning("⚠ Mentat completed with errors. ") +
						theme.muted("Please review the output carefully."),
				);
			} else {
				clack.outro(
					theme.primary("⚡ Mentat computation complete. ") +
						theme.muted("The analysis is now in your hands."),
				);
			}

			const comments = await this.cache.getComments(
				`${selectedPr.source.name}|${selectedPr.target.name}`,
			);
			if (comments.some((c) => c.status === "pending" || !c.status)) {
				// TODO: ask user if they want to handle comments now
				await this.handleComments(
					`${selectedPr.source.name}|${selectedPr.target.name}`,
				);
			}
		} catch (error) {
			clack.cancel(
				theme.error("✗ Mentat encountered an error:\n") +
					theme.muted(`   ${(error as Error).message}`),
			);
			throw error;
		} finally {
			// Remove signal handlers to prevent double cleanup
			process.removeAllListeners("SIGINT");
			process.removeAllListeners("SIGTERM");

			// Always restore branch (for normal exit)
			await cleanup();
		}
	}

	private setupCleanupHandlers(currentBranch: string): {
		cleanup: (signal?: string) => Promise<void>;
		cleanupDone: { value: boolean };
	} {
		const cleanupDone = { value: false };

		const cleanup = async (signal?: string) => {
			if (cleanupDone.value) {
				return;
			}
			cleanupDone.value = true;

			try {
				console.log(""); // Ensure clean line
				const s = this.ui.spinner();
				s.start(theme.muted(`Restoring original state (${currentBranch})...`));
				await this.git.checkout(currentBranch);
				s.stop(theme.success("✓ Repository state restored"));

				if (signal) {
					clack.outro(theme.warning(`⚠ Process interrupted (${signal})`));
				}
			} catch (error) {
				console.error(error);
				clack.log.error(
					theme.error("⚠ Failed to restore branch state\n") +
						theme.muted(
							`   Please manually run: git checkout ${currentBranch}`,
						),
				);
			} finally {
				if (signal) {
					process.exit(130); // 130 is standard exit code for SIGINT
				}
			}
		};

		const signalHandler = (signal: string) => {
			cleanup(signal).catch(() => process.exit(1));
		};

		process.on("SIGINT", () => signalHandler("SIGINT"));
		process.on("SIGTERM", () => signalHandler("SIGTERM"));

		return { cleanup, cleanupDone };
	}

	private async selectRemote(): Promise<string> {
		const s1 = this.ui.spinner();
		s1.start(theme.muted("Scanning git remotes"));

		const allRemotes = await this.git.getRemotes();
		s1.stop(theme.success(`✓ Found ${allRemotes.length} remote(s)`));

		return promptForRemote(allRemotes);
	}

	private async fetchPullRequests(
		remote: string,
	): Promise<{ provider: GitProvider; prs: PullRequest[] }> {
		const s2 = this.ui.spinner();
		s2.start(theme.muted("Querying pull requests from remote"));

		const provider = this.createProvider(remote);
		const prs = await provider.fetchPullRequests();

		s2.stop(theme.success(`✓ Retrieved ${prs.length} pull request(s)`));

		if (prs.length === 0) {
			clack.outro(theme.warning("No pull requests found. Mentat standing by."));
			process.exit(0);
		}

		return { provider, prs };
	}

	private async selectPullRequest(prs: PullRequest[]): Promise<PullRequest> {
		const selectedPr = await promptForPR(prs);

		clack.log.step(theme.muted(`Target: ${selectedPr.title}`));
		clack.log.step(
			theme.muted(
				`Source: ${selectedPr.source.name} (${selectedPr.source.commitHash.substring(0, 8)})`,
			),
		);
		clack.log.step(
			theme.muted(
				`Target: ${selectedPr.target.name} (${selectedPr.target.commitHash.substring(0, 8)})`,
			),
		);

		return selectedPr;
	}

	private async prepareRepository(
		remote: string,
		pr: PullRequest,
	): Promise<void> {
		const s3 = this.ui.spinner();
		s3.start(theme.muted("Synchronizing repository state"));

		try {
			s3.message(theme.muted("Fetching PR branches"));
			await this.git.fetch(remote, pr.source.name);
			await this.git.fetch(remote, pr.target.name);

			s3.message(
				theme.muted("Entering computation state (checking out source)"),
			);
			await this.git.checkout(pr.source.commitHash);

			s3.stop(theme.success("✓ Repository prepared"));
		} catch (error) {
			s3.stop(theme.error("✗ Repository synchronization failed"));
			this.ui.error(
				`Failed to prepare repository: ${(error as Error).message}`,
			);
			this.ui.info(`Try running: git fetch ${remote} ${pr.source.name}`);
			throw error;
		}
	}

	private async analyzeChanges(
		pr: PullRequest,
	): Promise<{ fullDiff: string; editedFiles: string[] }> {
		const s4 = this.ui.spinner();
		s4.start(theme.muted("Computing diff matrix"));

		const fullDiff = await this.git.getDiff(
			pr.target.commitHash,
			pr.source.commitHash,
		);
		const editedFiles = await this.git.getDiffSummary(
			pr.target.commitHash,
			pr.source.commitHash,
		);

		s4.stop(theme.success(`✓ Analyzed ${editedFiles.length} file(s)`));

		clack.log.info(
			theme.muted("Modified files: ") +
				theme.secondary(editedFiles.slice(0, 5).join(", ")) +
				(editedFiles.length > 5
					? theme.muted(` (+${editedFiles.length - 5} more)`)
					: ""),
		);

		return { fullDiff, editedFiles };
	}

	private async fetchCommitHistory(
		provider: GitProvider,
		pr: PullRequest,
	): Promise<string[]> {
		const s5 = this.ui.spinner();
		s5.start(theme.muted("Retrieving commit chronology"));

		const commitMessages = await provider.fetchCommits(pr);
		s5.stop(theme.success(`✓ Processed ${commitMessages.length} commit(s)`));

		console.log(""); // Spacing
		return commitMessages;
	}

	private async determineCacheStrategy(pr: PullRequest): Promise<{
		gatherContext: boolean;
		refreshCache: boolean;
		context?: string;
	}> {
		const cacheInput = {
			sourceBranch: pr.source.name,
			targetBranch: pr.target.name,
		};
		const hasCached = this.cache.has(cacheInput);
		const meta = hasCached ? this.cache.getMetadata(cacheInput) : undefined;

		let context: string | undefined;
		if (hasCached && meta) {
			context = this.cache.get(cacheInput) || undefined;
		}

		const { gatherContext, refreshCache } = await promptForCacheStrategy(
			hasCached,
			meta || undefined,
			pr.source.commitHash,
		);

		return { gatherContext, refreshCache, context };
	}

	private handleContextEvent(
		event: ContextEvent,
		context: {
			currentPhase: { value: Phase };
			Phase: typeof Phase;
			contextSpinner: ReturnType<UILogger["spinner"]>;
			contextHasError: { value: boolean };
			toolsByType: Map<string, number>;
		},
	): void {
		const {
			currentPhase,
			Phase,
			contextSpinner,
			contextHasError,
			toolsByType,
		} = context;

		switch (event.type) {
			case "context_start":
				currentPhase.value = Phase.CONTEXT;
				this.ui.section("Deep Context Gathering");
				contextSpinner.start(
					theme.accent("Gathering deep context from pull request metadata"),
				);
				break;

			case "context_tool_result":
				if (contextHasError.value) {
					break;
				}
				contextSpinner.message(theme.secondary("Thinking"));
				break;

			case "context_thinking":
				// Reserved for future token streaming
				break;

			case "context_tool_call": {
				if (contextHasError.value) {
					break;
				}

				const count = toolsByType.get(event.toolName) || 0;
				toolsByType.set(event.toolName, count + 1);

				const displayMessage = this.getContextToolMessage(
					event.toolName,
					event.input,
				);
				const spinnerMessage = displayMessage.split(" ", 1)[0];
				this.ui.info(displayMessage);
				contextSpinner.message(theme.secondary(spinnerMessage));
				break;
			}

			case "context_tool_call_reasoning":
				this.ui.step(event.message);
				break;

			case "context_success":
				if (currentPhase.value === Phase.CONTEXT && !contextHasError.value) {
					const message =
						event.dataSource === "cache"
							? "Using cached deep context"
							: `Context gathered using ${toolsByType.size} tool call(s)`;
					contextSpinner.stop(theme.success(`✓ ${message}`));
				}
				break;

			case "context_error":
				contextHasError.value = true;
				contextSpinner.stop(theme.error("✗ Context gathering failed"));
				this.ui.error(event.message);
				this.ui.warn("Proceeding with review using limited context");
				break;

			case "context_data":
				this.cache.set(
					{
						sourceBranch: event.data.sourceBranch,
						targetBranch: event.data.targetBranch,
						currentCommit: event.data.currentCommit,
					},
					event.data.context,
				);
				break;
		}
	}

	private handleReviewEvent(
		event: ReviewEvent,
		context: {
			currentPhase: { value: Phase };
			Phase: typeof Phase;
			reviewSpinner: ReturnType<UILogger["spinner"]>;
			reviewHasError: { value: boolean };
			contextHasError: { value: boolean };
			toolsByType: Map<string, number>;
		},
	): void {
		const {
			currentPhase,
			Phase,
			reviewSpinner,
			reviewHasError,
			contextHasError,
			toolsByType,
		} = context;

		switch (event.type) {
			case "review_start":
				if (currentPhase.value === Phase.CONTEXT) {
					this.ui.sectionComplete("Deep context synthesis complete");
					currentPhase.value = Phase.REVIEW;
				}

				if (contextHasError.value) {
					this.ui.warn("Starting review with degraded context");
				}

				this.ui.section("Code Review Analysis");
				reviewSpinner.start(
					theme.accent("Initializing Claude Code in read-only mode"),
				);
				break;

			case "review_thinking": {
				if (reviewHasError.value) {
					break;
				}

				const text = event.text.trim();
				if (text.length > 10 && text.length < 100) {
					const display =
						text.length > 70 ? text.substring(0, 70) + "..." : text;
					reviewSpinner.message(theme.dim(`💭 ${display}`));
				}
				break;
			}

			case "review_tool_call": {
				if (reviewHasError.value) {
					break;
				}

				const count = toolsByType.get(event.toolName) || 0;
				toolsByType.set(event.toolName, count + 1);

				const displayMessage = this.getReviewToolMessage(
					event.toolName,
					event.input,
				);
				const spinnerMessage = displayMessage.split(" ", 1)[0];
				this.ui.info(displayMessage);
				reviewSpinner.message(theme.secondary(spinnerMessage));
				break;
			}

			case "review_tool_result":
				if (reviewHasError.value) {
					break;
				}
				reviewSpinner.message(theme.secondary("Analyzing"));
				break;

			case "review_success":
				if (currentPhase.value === Phase.REVIEW && !reviewHasError.value) {
					const message = `Review complete: ${event.commentCount} observation(s)`;
					reviewSpinner.stop(theme.success(`✓ ${message}`));
					this.ui.sectionComplete("Analysis complete");
					currentPhase.value = Phase.COMPLETE;
				}
				break;

			case "review_data":
				// TODO: Put comments in cache
				break;

			case "review_error":
				reviewHasError.value = true;
				reviewSpinner.stop(theme.error("✗ Review failed"));
				this.ui.error(event.message);
				break;
		}
	}

	private async processReviewStream(
		pr: PullRequest,
		commitMessages: string[],
		fullDiff: string,
		editedFiles: string[],
		cacheConfig: {
			gatherContext: boolean;
			refreshCache: boolean;
			context?: string;
		},
	): Promise<{ contextHasError: boolean; reviewHasError: boolean }> {
		enum Phase {
			INIT = "init",
			CONTEXT = "context",
			REVIEW = "review",
			COMPLETE = "complete",
		}

		const currentPhase = { value: Phase.INIT };
		const contextSpinner = this.ui.spinner();
		const reviewSpinner = this.ui.spinner();
		const contextHasError = { value: false };
		const reviewHasError = { value: false };
		const toolsByType = new Map<string, number>();

		const events = this.reviewService.streamReview({
			commits: commitMessages,
			title: pr.title,
			description: pr.description || "",
			editedFiles,
			sourceHash: pr.source.commitHash,
			sourceName: pr.source.name,
			targetHash: pr.target.commitHash,
			targetName: pr.target.name,
			diff: fullDiff,
			...cacheConfig,
		});

		for await (const event of events) {
			if ("type" in event) {
				const eventContext = {
					currentPhase,
					Phase,
					contextSpinner,
					reviewSpinner,
					contextHasError,
					reviewHasError,
					toolsByType,
				};

				if (isContextEvent(event)) {
					this.handleContextEvent(event, eventContext);
				} else if (isReviewEvent(event)) {
					this.handleReviewEvent(event, eventContext);
				}
			} else {
				console.log(""); // Spacing
				displayContext(event.context);
				displayComments(event.comments);
				const prKey = `${pr.source.name}|${pr.target.name}`;
				await this.saveCommentsToCache(event.comments, prKey);
			}
		}

		return {
			contextHasError: contextHasError.value,
			reviewHasError: reviewHasError.value,
		};
	}

	private async handleComments(prKey: string): Promise<void> {
		console.log("");
		this.ui.section("Comment Resolution");

		// ✅ Load all comments from cache (includes status)
		const allComments = await this.cache.getComments(prKey);

		// ✅ Filter to only pending comments
		const pendingComments = allComments.filter(
			(c) => c.status === "pending" || !c.status,
		);

		if (pendingComments.length === 0) {
			clack.log.success(theme.success("✓ All comments resolved"));

			// Show summary of resolved comments
			const resolvedSummary = {
				accepted: allComments.filter((c) => c.status === "accepted").length,
				fixed: allComments.filter((c) => c.status === "fixed").length,
				rejected: allComments.filter((c) => c.status === "rejected").length,
			};

			if (allComments.length > 0) {
				console.log("");
				clack.log.info(theme.secondary("Previous resolution:"));
				if (resolvedSummary.fixed > 0) {
					clack.log.step(`✓ Fixed: ${resolvedSummary.fixed}`);
				}
				if (resolvedSummary.accepted > 0) {
					clack.log.step(`✓ Accepted: ${resolvedSummary.accepted}`);
				}
				if (resolvedSummary.rejected > 0) {
					clack.log.step(`✗ Rejected: ${resolvedSummary.rejected}`);
				}
			}

			return;
		}

		clack.log.info(
			theme.secondary(
				`Found ${pendingComments.length} pending comment(s) ` +
					`(${allComments.length} total)`,
			),
		);

		// Summary tracker
		const summary = {
			accepted: 0,
			fixed: 0,
			rejected: 0,
			skipped: 0,
		};

		// ✅ Process each pending comment
		for (let i = 0; i < pendingComments.length; i++) {
			const comment = pendingComments[i];
			if (!comment) {
				continue;
			}

			console.log("");
			console.log("─".repeat(60));
			console.log("");

			// Show progress
			this.ui.info(
				theme.primary(`Comment ${i + 1}/${pendingComments.length}:`) +
					" " +
					theme.secondary(comment.message.substring(0, 60)) +
					(comment.message.length > 60 ? "..." : ""),
			);

			// ✅ Display comment with context
			await this.displayCommentWithContext(comment);

			console.log("");

			// ✅ Get user decision
			const action = await clack.select({
				message: theme.primary("What should we do?"),
				options: [
					{
						value: "fix",
						label: "🔧 Fix with Claude",
						hint: "Let Claude Code plan and implement a fix",
					},
					{
						value: "accept",
						label: "✓ Accept",
						hint: "Accept the comment without changes",
					},
					{
						value: "reject",
						label: "✗ Reject",
						hint: "Reject this comment permanently",
					},
					{
						value: "skip",
						label: "⏭ Skip",
						hint: "Skip for now, address in next session",
					},
					{
						value: "quit",
						label: "💤 Quit",
						hint: "Stop processing and exit",
					},
				],
			});

			if (clack.isCancel(action)) {
				clack.cancel("Comment resolution cancelled");
				break;
			}

			// Handle user action
			switch (action) {
				case "fix": {
					// ✅ Get optional notes for Claude
					const optionalNotes = await this.promptOptionalNotes();

					// ✅ Get full diff for context
					const fullDiff = await this.getFullDiff();

					// ✅ Run the fix session (planning + execution)
					await this.runFixSession(
						comment,
						prKey,
						fullDiff,
						optionalNotes,
						summary,
					);
					break;
				}

				case "accept":
					await this.cache.updateComment(prKey, comment.id, {
						status: "accepted",
					});
					summary.accepted++;
					clack.log.success(theme.success("✓ Comment accepted"));
					break;

				case "reject": {
					// Update comment with rejection
					await this.cache.updateComment(prKey, comment.id, {
						status: "rejected",
					});

					summary.rejected++;
					clack.log.step(theme.muted("✗ Comment rejected"));
					break;
				}

				case "skip":
					// Status remains 'pending', will show up next time
					summary.skipped++;
					clack.log.step(theme.muted("⏭ Comment skipped"));
					break;

				case "quit":
					clack.log.info(theme.secondary("Exiting comment resolution..."));

					// Show partial summary
					if (summary.fixed + summary.accepted + summary.rejected > 0) {
						console.log("");
						this.displayResolutionSummary(summary);
					}

					this.ui.sectionComplete("Comment resolution paused");
					return;
			}
		}

		// ✅ Display final summary
		console.log("");
		this.displayResolutionSummary(summary);
		this.ui.sectionComplete("Comment resolution complete");
	}

	// =====================================
	// Helper Methods
	// =====================================

	private async displayCommentWithContext(
		comment: ReviewComment,
	): Promise<void> {
		console.log("");

		// File info
		clack.log.info(theme.secondary(`📄 ${comment.file}`));

		// Line info
		if (comment.startLine && comment.endLine) {
			clack.log.step(
				theme.muted(`Lines ${comment.startLine}-${comment.endLine}`),
			);
		} else if (comment.line) {
			clack.log.step(theme.muted(`Line ${comment.line}`));
		}

		// ✅ Show the actual code lines
		try {
			const fs = await import("node:fs/promises");
			const fileContent = await fs.readFile(comment.file, "utf-8");
			const lines = fileContent.split("\n");

			const startLine = (comment.startLine || comment.line || 1) - 1;
			const endLine = comment.endLine || comment.line || startLine + 1;

			// Show a few lines of context before and after
			const contextBefore = 2;
			const contextAfter = 2;
			const displayStart = Math.max(0, startLine - contextBefore);
			const displayEnd = Math.min(lines.length, endLine + contextAfter);

			console.log("");
			clack.log.info(theme.dim("Code:"));

			for (let i = displayStart; i < displayEnd; i++) {
				const lineNum = i + 1;
				const lineContent = lines[i];

				// Highlight the problematic lines
				const isProblematic =
					(comment.line && lineNum === comment.line) ||
					(comment.startLine &&
						comment.endLine &&
						lineNum >= comment.startLine &&
						lineNum <= comment.endLine);

				const prefix = isProblematic ? theme.error("→ ") : "  ";
				const numStr = lineNum.toString().padStart(4, " ");
				const lineColor = isProblematic ? theme.error : theme.dim;

				console.log(`${prefix}${numStr} │ ${lineColor(lineContent)}`);
			}
		} catch (_error) {
			clack.log.warn(theme.warning("Could not read file to display context"));
		}

		// Comment details
		console.log("");
		clack.log.info(
			theme.secondary(`📝 ${comment.severity || "info"}`.toUpperCase()),
		);
		clack.log.step(theme.primary(comment.message));

		if (comment.rationale) {
			clack.log.step(theme.dim(`Why: ${comment.rationale}`));
		}
	}

	private async promptOptionalNotes(): Promise<string | undefined> {
		const response = await clack.text({
			message: "Any optional context/notes for Claude? (press Enter to skip)",
			placeholder: 'e.g., "Use async/await, not callbacks"',
		});

		if (clack.isCancel(response)) {
			return undefined;
		}

		const text = response as string;
		return text && text.trim().length > 0 ? text.trim() : undefined;
	}

	// private async promptRejectionReason(): Promise<string | undefined> {
	// 	const response = await clack.text({
	// 		message: "Why are you rejecting this comment? (optional)",
	// 		placeholder: 'e.g., "Not applicable to this codebase"',
	// 	});

	// 	if (clack.isCancel(response)) {
	// 		return undefined;
	// 	}

	// 	const text = response as string;
	// 	return text && text.trim().length > 0 ? text.trim() : undefined;
	// }

	private async getFullDiff(): Promise<string> {
		try {
			const { exec } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execAsync = promisify(exec);

			// Get diff between target and current branch
			const { stdout } = await execAsync("git diff HEAD~1");
			return stdout;
		} catch (error) {
			this.ui.warn(`Could not get full diff: ${(error as Error).message}`);
			return "";
		}
	}

	private displayResolutionSummary(summary: {
		accepted: number;
		fixed: number;
		rejected: number;
		skipped: number;
	}): void {
		clack.log.info(theme.primary("📊 Resolution Summary:"));

		const total =
			summary.accepted + summary.fixed + summary.rejected + summary.skipped;

		if (total === 0) {
			clack.log.step(theme.dim("No comments were processed"));
			return;
		}

		if (summary.fixed > 0) {
			clack.log.step(theme.success(`✓ Fixed: ${summary.fixed}`));
		}

		if (summary.accepted > 0) {
			clack.log.step(theme.success(`✓ Accepted: ${summary.accepted}`));
		}

		if (summary.rejected > 0) {
			clack.log.step(theme.muted(`✗ Rejected: ${summary.rejected}`));
		}

		if (summary.skipped > 0) {
			clack.log.step(theme.warning(`⏭ Skipped: ${summary.skipped}`));
		}
	}

	private async saveCommentsToCache(
		comments: ReviewComment[],
		prKey: string,
	): Promise<ReviewCommentWithId[]> {
		// Add IDs to comments if missing
		const commentsWithIds = comments.map((c) => ({
			...c,
			id: c.id || randomUUID(),
			status: c.status || ("pending" as ReviewCommentStatus),
		}));

		// Check if we already have comments cached
		const existingComments = await this.cache.getComments(prKey);

		if (existingComments.length > 0) {
			// Merge: keep status from existing, add new comments
			const merged = this.mergeComments(existingComments, commentsWithIds);
			await this.cache.saveComments(prKey, merged);

			clack.log.info(
				theme.secondary(
					`Found ${existingComments.length} cached comment(s), ` +
						`${commentsWithIds.length} from review`,
				),
			);
		} else {
			// Fresh save
			await this.cache.saveComments(prKey, commentsWithIds);
			clack.log.info(
				theme.secondary(`Saved ${commentsWithIds.length} comment(s) to cache`),
			);
		}

		return commentsWithIds;
	}

	private mergeComments(
		existing: ReviewComment[],
		fresh: ReviewComment[],
	): ReviewComment[] {
		const merged = new Map<string, ReviewComment>();

		// First, add all existing comments (with their status preserved)
		for (const comment of existing) {
			merged.set(this.getCommentFingerprint(comment), comment);
		}

		// Then, merge in fresh comments
		for (const comment of fresh) {
			const fingerprint = this.getCommentFingerprint(comment);

			if (merged.has(fingerprint)) {
				// Comment already exists - keep existing status, update message if changed
				const existingComment = merged.get(fingerprint);
				if (existingComment) {
					merged.set(fingerprint, {
						...comment,
						id: existingComment.id, // Keep same ID
						status: existingComment.status, // Keep status
					});
				}
			} else {
				// New comment - add with fresh ID
				merged.set(fingerprint, comment);
			}
		}

		return Array.from(merged.values());
	}

	private getCommentFingerprint(comment: ReviewComment): string {
		// Use file + line + message to identify same comment
		const key = `${comment.file}:${comment.line || 0}:${comment.message}`;
		return createHash("md5").update(key).digest("hex");
	}

	private async runFixSession(
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

		// =====================================
		// PHASE 1: PLANNING
		// =====================================

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
					return;
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
					return;
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
					return;
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
					return;
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
			return;
		}

		// =====================================
		// PHASE 2: EXECUTION
		// =====================================

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

			// ✓ Execution completed successfully
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
			// TODO: Implement git.status() method
			// try {
			// 	const status = await this.git.status();
			// 	const modifiedFiles = status.modified;
			//
			// 	if (modifiedFiles.length > 0) {
			// 		const shouldRevert = await clack.confirm({
			// 			message: "Revert changes made before the error?",
			// 			initialValue: true,
			// 		});
			//
			// 		if (shouldRevert && !clack.isCancel(shouldRevert)) {
			// 			await this.revertChanges(modifiedFiles);
			// 		}
			// 	}
			// } catch {
			// 	// Ignore revert errors
			// }

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

	private getContextToolMessage(toolName: string, arg?: string): string {
		const messages: Record<string, string> = {
			search: `🔍 Searching Jira${arg ? `: "${arg}"` : ""}`,
			getIssue: `📋 Fetching issue${arg ? ` ${arg}` : ""}`,
			getJiraIssue: `📋 Fetching issue${arg ? ` ${arg}` : ""}`,
			searchConfluencePages: `📚 Searching Confluence${arg ? `: "${arg}"` : ""}`,
			getConfluencePage: `📄 Reading page${arg ? ` ${arg}` : ""}`,
			fetch: `📡 Fetching resource${arg ? `: ${arg}` : ""}`,
			getAccessibleAtlassianResources: `🌐 Listing accessible resources${arg ? `: ${arg}` : ""}`,
		};
		return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ""}`;
	}

	private getReviewToolMessage(toolName: string, arg?: string): string {
		const messages: Record<string, string> = {
			Read: `📖 Reading ${arg || "file"}`,
			Grep: `🔍 Searching for pattern${arg ? `: ${arg}` : ""}`,
			Glob: `📁 Finding files${arg ? `: ${arg}` : ""}`,
		};
		return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ""}`;
	}
}
