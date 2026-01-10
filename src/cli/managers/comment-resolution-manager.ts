import { createHash, randomUUID } from "node:crypto";
import * as clack from "@clack/prompts";
import type LocalCache from "../../cache/local-cache";
import { type PullRequest, getPRKey } from "../../providers/types";
import type {
	ReviewComment,
	ReviewCommentStatus,
	ReviewCommentWithId,
} from "../../review/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";
import { promptForPendingCommentsAction } from "../cli-prompts";

export class CommentResolutionManager {
	constructor(
		private cache: LocalCache,
		private ui: UILogger,
	) {}

	public async checkPendingComments(pr: PullRequest): Promise<boolean> {
		const prKey = getPRKey(pr);
		const commentsBefore = await this.cache.getComments(prKey);

		if (commentsBefore.length === 0) {
			return false;
		}

		clack.log.info(
			theme.secondary("This pull request was previously reviewed. "),
		);

		const pendingComments = commentsBefore.filter(
			(c) => c.status === "pending" || !c.status,
		);

		if (pendingComments.length === 0) {
			return false;
		}

		clack.log.info(
			theme.warning(
				`There are ${pendingComments.length} unresolved comment(s) from the last review session.`,
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
			clack.log.warn(
				theme.warning("⚠️  New commits detected since last review."),
			);
		}

		const action = await promptForPendingCommentsAction(
			pendingComments.length,
			hasNewCommits,
		);

		return action === "handle";
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

		// Process each pending comment
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

			// Display comment with context
			await displayCommentFn(comment);

			console.log("");

			// Get user decision
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
					await onFixRequested(comment, prKey, summary);
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
					await this.cache.updateComment(prKey, comment.id, {
						status: "rejected",
					});

					summary.rejected++;
					clack.log.step(theme.muted("✗ Comment rejected"));
					break;
				}

				case "skip":
					summary.skipped++;
					clack.log.step(theme.muted("⏭ Comment skipped"));
					break;

				case "quit":
					clack.log.info(theme.secondary("Exiting comment resolution..."));

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
