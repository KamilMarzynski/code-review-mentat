import { createHash, randomUUID } from "node:crypto";
import type LocalCache from "../../cache/local-cache";
import type {
	ReviewComment,
	ReviewCommentStatus,
	StoredReviewComment,
} from "../../review/types";
import type { CodeContextReader } from "../../ui/code-context-reader";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";
import { promptCommentAction } from "../cli-prompts";
import type { HandleCommentsResult } from "../types";

/**
 * Manages comment resolution workflow
 *
 * Responsibilities:
 * - Retrieve comment state and statistics (pure data retrieval)
 * - Execute comment handling workflow
 * - Save and merge comments with status tracking
 */
export class CommentResolutionManager {
	constructor(
		private codeContextReader: CodeContextReader,
		private cache: LocalCache,
		private ui: UILogger,
	) {}

	/**
	 * Get comprehensive state of all comments for a PR
	 * Pure data retrieval - no user interaction
	 */
	public async getCommentsState(prKey: string): Promise<{
		total: number;
		pending: number;
		accepted: number;
		fixed: number;
		rejected: number;
		comments: StoredReviewComment[];
	}> {
		const comments = await this.cache.getComments(prKey);

		return {
			total: comments.length,
			pending: comments.filter((c) => c.status === "pending" || !c.status)
				.length,
			accepted: comments.filter((c) => c.status === "accepted").length,
			fixed: comments.filter((c) => c.status === "fixed").length,
			rejected: comments.filter((c) => c.status === "rejected").length,
			comments,
		};
	}

	/**
	 * Get only pending comments
	 * Pure data retrieval - no user interaction
	 */
	public async getPendingComments(
		prKey: string,
	): Promise<StoredReviewComment[]> {
		const comments = await this.cache.getComments(prKey);
		return comments.filter((c) => c.status === "pending" || !c.status);
	}

	/**
	 * Get only accepted comments
	 * Pure data retrieval - no user interaction
	 */
	public async getAcceptedComments(
		prKey: string,
	): Promise<StoredReviewComment[]> {
		const comments = await this.cache.getComments(prKey);
		return comments.filter((c) => c.status === "accepted");
	}

	/**
	 * Execute comment resolution workflow
	 * Returns structured result for use by orchestrator/post-action handlers
	 */
	/**
	 * Execute comment resolution workflow
	 * Returns structured result for use by orchestrator/post-action handlers
	 */
	public async handleComments(
		prKey: string,
		onFixRequested: (
			comment: ReviewComment,
			prKey: string,
			summary: {
				accepted: number;
				fixed: number;
				rejected: number;
				skipped: number;
			},
		) => Promise<void>,
		displayCommentFn: (comment: ReviewComment) => Promise<void>,
	): Promise<HandleCommentsResult> {
		console.log("");
		this.ui.section("Comment Resolution");

		// Load all comments from cache (includes status)
		const allComments = await this.cache.getComments(prKey);

		// Filter to only pending comments
		const pendingComments = allComments.filter(
			(c) => c.status === "pending" || !c.status,
		);

		if (pendingComments.length === 0) {
			this.ui.success(theme.success("✓ All comments resolved"));

			// Show summary of resolved comments
			const resolvedSummary = {
				accepted: allComments.filter((c) => c.status === "accepted").length,
				fixed: allComments.filter((c) => c.status === "fixed").length,
				rejected: allComments.filter((c) => c.status === "rejected").length,
			};

			if (allComments.length > 0) {
				console.log("");
				this.ui.info(theme.secondary("Previous resolution:"));
				if (resolvedSummary.fixed > 0) {
					this.ui.logStep(`✓ Fixed: ${resolvedSummary.fixed}`);
				}
				if (resolvedSummary.accepted > 0) {
					this.ui.logStep(`✓ Accepted: ${resolvedSummary.accepted}`);
				}
				if (resolvedSummary.rejected > 0) {
					this.ui.logStep(`✗ Rejected: ${resolvedSummary.rejected}`);
				}
			}

			return {
				processed: 0,
				fixed: 0,
				accepted: 0,
				rejected: 0,
				skipped: 0,
			};
		}

		this.ui.info(
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

		// Process each pending comment
		for (let i = 0; i < pendingComments.length; i++) {
			const comment = pendingComments[i];
			if (!comment) {
				continue;
			}

			this.ui.space();
			this.ui.log(
				theme.primary(`━━━ Comment ${i + 1} of ${pendingComments.length} ━━━`),
			);
			this.ui.space();

			// Loop until we get a non-create_memory action
			// (allows user to create memory, then decide what to do with the comment)
			let shouldContinue = true;
			let hideCreateMemory = comment.memoryCreated === true;

			while (shouldContinue) {
				// Display comment with context
				await displayCommentFn(comment);
				this.ui.space();

				// Get user decision (hide create_memory if already created)
				const action = await promptCommentAction(hideCreateMemory);

				if (action === null) {
					this.ui.cancel("Comment resolution cancelled");
					shouldContinue = false;
					break;
				}

				// Handle user action
				switch (action) {
					case "create_memory": {
						this.ui.info(theme.accent("Creating memory from comment..."));

						// TODO: Implement actual MCP memory creation here
						// Example:
						// await mcpClient.createEntity({
						//   entityType: "code_review_pattern",
						//   name: `Review: ${comment.file}`,
						//   observations: [comment.message, comment.rationale]
						// });

						this.ui.warn(
							theme.warning(
								"⚠️ MCP memory integration not yet implemented - placeholder only",
							),
						);

						// Mark that memory was created for this comment
						await this.cache.updateComment(prKey, comment.id, {
							memoryCreated: true,
						});

						this.ui.success(theme.success("✓ Memory created (and cached)"));

						// Loop back: re-display comment and prompt again (without create_memory option)
						this.ui.space();
						this.ui.info(
							theme.secondary("Now decide what to do with this comment:"),
						);
						this.ui.space();

						// Hide create_memory option on next iteration
						hideCreateMemory = true;
						// Continue the while loop to re-prompt
						break;
					}

					case "fix": {
						await onFixRequested(comment, prKey, summary);
						shouldContinue = false;
						break;
					}

					case "accept":
						await this.cache.updateComment(prKey, comment.id, {
							status: "accepted",
						});
						summary.accepted++;
						this.ui.success(theme.success("✓ Comment accepted"));
						shouldContinue = false;
						break;

					case "reject": {
						await this.cache.updateComment(prKey, comment.id, {
							status: "rejected",
						});
						summary.rejected++;
						this.ui.logStep(theme.muted("✗ Comment rejected"));
						shouldContinue = false;
						break;
					}

					case "skip":
						summary.skipped++;
						this.ui.logStep(theme.muted("⏭ Comment skipped"));
						shouldContinue = false;
						break;

					case "quit":
						this.ui.info(theme.secondary("Exiting comment resolution..."));

						if (summary.fixed + summary.accepted + summary.rejected > 0) {
							console.log("");
							this.displayResolutionSummary(summary);
						}

						this.ui.sectionComplete("Comment resolution paused");
						return {
							processed: summary.fixed + summary.accepted + summary.rejected,
							fixed: summary.fixed,
							accepted: summary.accepted,
							rejected: summary.rejected,
							skipped: summary.skipped,
						};
				}

				if (!shouldContinue && action === null) {
					// If user cancelled, break out of loop
					break;
				}
			}
		}

		// Display final summary
		console.log("");
		this.displayResolutionSummary(summary);
		this.ui.sectionComplete("Comment resolution complete");

		return {
			processed: summary.fixed + summary.accepted + summary.rejected,
			fixed: summary.fixed,
			accepted: summary.accepted,
			rejected: summary.rejected,
			skipped: summary.skipped,
		};
	}

	public displayResolutionSummary(summary: {
		accepted: number;
		fixed: number;
		rejected: number;
		skipped: number;
	}): void {
		this.ui.info(theme.primary("📊 Resolution Summary:"));

		const total =
			summary.accepted + summary.fixed + summary.rejected + summary.skipped;

		if (total === 0) {
			this.ui.logStep(theme.dim("No comments were processed"));
			return;
		}

		if (summary.fixed > 0) {
			this.ui.logStep(theme.success(`✓ Fixed: ${summary.fixed}`));
		}

		if (summary.accepted > 0) {
			this.ui.logStep(theme.success(`✓ Accepted: ${summary.accepted}`));
		}

		if (summary.rejected > 0) {
			this.ui.logStep(theme.muted(`✗ Rejected: ${summary.rejected}`));
		}

		if (summary.skipped > 0) {
			this.ui.logStep(theme.warning(`⏭ Skipped: ${summary.skipped}`));
		}
	}

	public async saveCommentsToCache(
		comments: ReviewComment[],
		prKey: string,
	): Promise<StoredReviewComment[]> {
		// Add IDs to comments if missing and fetch code snippets
		const commentsWithIds = await Promise.all(
			comments.map(async (c) => {
				let codeSnippet = "";
				if (c.startLine !== undefined && c.endLine !== undefined) {
					const fileRange = await this.codeContextReader.readFileRange(
						c.file,
						c.startLine,
						c.endLine,
					);
					if (fileRange.success) {
						codeSnippet = fileRange.lines
							.map((line) => line.content)
							.join("\n");
					}
				} else if (c.line !== undefined) {
					const fileLines = await this.codeContextReader.readFileLines(
						c.file,
						c.line,
					);
					if (fileLines.success) {
						codeSnippet = fileLines.lines
							.map((line) => line.content)
							.join("\n");
					}
				}

				return {
					...c,
					id: c.id || randomUUID(),
					status: c.status || ("pending" as ReviewCommentStatus),
					codeSnippet,
				};
			}),
		);

		// Check if we already have comments cached
		const existingComments = await this.cache.getComments(prKey);

		if (existingComments.length > 0) {
			// Merge: keep status from existing, add new comments
			const merged = this.mergeComments(existingComments, commentsWithIds);
			await this.cache.saveComments(prKey, merged);
		} else {
			// Fresh save
			await this.cache.saveComments(prKey, commentsWithIds);
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
}
