import { createHash, randomUUID } from "node:crypto";
import type LocalCache from "../../cache/local-cache";
import { getPRKey, type PullRequest } from "../../git-providers/types";
import type {
	ReviewComment,
	ReviewCommentStatus,
	ReviewCommentWithId,
} from "../../review/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";
import {
	promptCommentAction,
	promptContinueWithAllResolved,
	promptForPendingCommentsAction,
} from "../cli-prompts";

export class CommentResolutionManager {
	constructor(
		private cache: LocalCache,
		private ui: UILogger,
	) {}

	public async checkPendingComments(
		pr: PullRequest,
	): Promise<"handle_comments" | "re_review" | "none"> {
		const prKey = getPRKey(pr);
		const commentsBefore = await this.cache.getComments(prKey);

		if (commentsBefore.length === 0) {
			return "none";
		}

		const pendingComments = commentsBefore.filter(
			(c) => c.status === "pending" || !c.status,
		);

		// Case 1: All comments are resolved
		if (pendingComments.length === 0) {
			const resolvedSummary = {
				accepted: commentsBefore.filter((c) => c.status === "accepted").length,
				fixed: commentsBefore.filter((c) => c.status === "fixed").length,
				rejected: commentsBefore.filter((c) => c.status === "rejected").length,
			};

			this.ui.success(
				theme.success(
					`✓ All ${commentsBefore.length} comment(s) from previous review are resolved.`,
				),
			);

			// Show resolution summary
			const summaryParts: string[] = [];
			if (resolvedSummary.fixed > 0) {
				summaryParts.push(`${resolvedSummary.fixed} fixed`);
			}
			if (resolvedSummary.accepted > 0) {
				summaryParts.push(`${resolvedSummary.accepted} accepted`);
			}
			if (resolvedSummary.rejected > 0) {
				summaryParts.push(`${resolvedSummary.rejected} rejected`);
			}

			if (summaryParts.length > 0) {
				this.ui.info(theme.muted(`  ${summaryParts.join(", ")}`));
			}

			const shouldContinue = await promptContinueWithAllResolved();

			if (!shouldContinue) {
				return "none";
			}

			return "re_review";
		}

		// Case 2: Has pending comments
		this.ui.info(
			theme.warning(
				`There are ${pendingComments.length} unresolved comment(s) from the last review.`,
			),
		);

		// Check if there are new commits since last review
		const cacheInput = {
			sourceBranch: pr.source.name,
			targetBranch: pr.target.name,
		};
		const cacheMetadata = this.cache.getMetadata(cacheInput);
		const hasNewCommits =
			cacheMetadata?.gatheredFromCommit !== pr.source.commitHash;

		if (hasNewCommits) {
			this.ui.warn(theme.warning("⚠️  New commits detected since last review."));
		}

		const action = await promptForPendingCommentsAction(
			pendingComments.length,
			hasNewCommits,
		);

		return action;
	}

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
	): Promise<void> {
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

			return;
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

			// Display comment with context
			await displayCommentFn(comment);

			this.ui.space();

			// Get user decision
			const action = await promptCommentAction();

			if (action === null) {
				this.ui.cancel("Comment resolution cancelled");
				break;
			}

			// Handle user action
			switch (action) {
				case "fix": {
					await onFixRequested(comment, prKey, summary);
					break;
				}

				case "accept":
					await this.cache.updateComment(prKey, comment.id, {
						status: "accepted",
					});
					summary.accepted++;
					this.ui.success(theme.success("✓ Comment accepted"));
					break;

				case "reject": {
					await this.cache.updateComment(prKey, comment.id, {
						status: "rejected",
					});

					summary.rejected++;
					this.ui.logStep(theme.muted("✗ Comment rejected"));
					break;
				}

				case "skip":
					summary.skipped++;
					this.ui.logStep(theme.muted("⏭ Comment skipped"));
					break;

				case "quit":
					this.ui.info(theme.secondary("Exiting comment resolution..."));

					if (summary.fixed + summary.accepted + summary.rejected > 0) {
						console.log("");
						this.displayResolutionSummary(summary);
					}

					this.ui.sectionComplete("Comment resolution paused");
					return;
			}
		}

		// Display final summary
		console.log("");
		this.displayResolutionSummary(summary);
		this.ui.sectionComplete("Comment resolution complete");
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
