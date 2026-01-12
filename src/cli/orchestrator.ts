import type LocalCache from "../cache/local-cache";
import {
	getPRKey,
	type GitProvider,
	type PullRequest,
} from "../git-providers/types";
import { ui } from "../ui/logger";
import { theme } from "../ui/theme";
import {
	promptToResolveComments,
	promptToSendCommentsToRemote,
} from "./cli-prompts";
import { displayHeader } from "./display";
import type { CommentDisplayService } from "./managers/comment-display-service";
import type { CommentResolutionManager } from "./managers/comment-resolution-manager";
import type { FixSessionOrchestrator } from "./managers/fix-session-orchestrator";
import type { PRWorkflowManager } from "./managers/pr-workflow-manager";
import type { ReviewStreamHandler } from "./managers/review-stream-handler";

export class CLIOrchestrator {
	constructor(
		private prWorkflow: PRWorkflowManager,
		private reviewHandler: ReviewStreamHandler,
		private commentResolution: CommentResolutionManager,
		private fixSession: FixSessionOrchestrator,
		private commentDisplay: CommentDisplayService,
		private cache: LocalCache,
	) {}

	public async run(): Promise<void> {
		displayHeader();
		ui.intro(theme.computation("Mentat analysis protocol initiated"));

		// Check for uncommitted changes before proceeding
		const dirtyWorkspace = await this.prWorkflow.checkWorkspaceClean();
		if (dirtyWorkspace) {
			process.exit(1); // Exit cleanly with error code
		}

		const { cleanup } = await this.prWorkflow.setupCleanupHandlers();

		try {
			// Step 1-2: Remote selection and PR fetching
			const selectedRemote = await this.prWorkflow.selectRemote();
			const { provider, prs } =
				await this.prWorkflow.fetchPullRequests(selectedRemote);

			// Step 3: PR selection
			const selectedPr = await this.prWorkflow.selectPullRequest(prs);

			// Step 4: Repository preparation
			await this.prWorkflow.prepareRepository(selectedRemote, selectedPr);

			// Step 5: Changes analysis
			const { fullDiff, editedFiles } =
				await this.prWorkflow.analyzeChanges(selectedPr);

			// Step 6: Commit history
			const commitMessages = await this.prWorkflow.fetchCommitHistory(
				provider,
				selectedPr,
			);

			// Step 7: Check for pending comments from previous review
			const commentAction =
				await this.commentResolution.checkPendingComments(selectedPr);

			if (commentAction === "handle_comments") {
				await this.handleComments(getPRKey(selectedPr));
				return;
			} else if (!commentAction || commentAction === "none") {
				// Step 8: Handle existing approved comments from previous reviews
				await this.handleAcceptedCommentsIfExist(selectedPr, provider);
				return;
			}

			// Step 9: Determine cache/context strategy first (natural order: data before actions)
			const contextConfig =
				await this.reviewHandler.determineContextStrategy(selectedPr);

			// Step 10: Process review stream
			const { contextHasError, reviewHasError } =
				await this.reviewHandler.processReviewStream(
					selectedPr,
					commitMessages,
					fullDiff,
					editedFiles,
					contextConfig,
				);

			console.log(""); // Spacing

			// Check for comments to display summary
			const comments = await this.cache.getComments(getPRKey(selectedPr));

			if (comments.length > 0 && !reviewHasError) {
				// Display review summary if comments exist
				console.log("");
				console.log(theme.muted("─".repeat(60)));
				this.commentDisplay.displayReviewSummary(comments);
			}

			if (contextHasError || reviewHasError) {
				ui.outro(
					theme.warning("⚠ Computation completed with errors. ") +
						theme.muted("Review the output above for details."),
				);
			} else {
				ui.outro(
					theme.computation("⚡ Computation complete. ") +
						theme.muted("Assessment data synthesized."),
				);
			}

			// Check for pending comments to handle
			const pendingComments = comments.filter(
				(c) => c.status === "pending" || !c.status,
			);

			if (pendingComments.length > 0) {
				console.log("");
				console.log(theme.muted("─".repeat(60)));
				console.log("");

				const shouldResolve = await promptToResolveComments();

				if (!shouldResolve) {
					ui.info(
						theme.muted(
							"Comments are saved. You can review them anytime by running the tool again.",
						),
					);
					return;
				}

				await this.handleComments(getPRKey(selectedPr));
			}

			await this.handleAcceptedCommentsIfExist(selectedPr, provider);
			return;
		} catch (error) {
			ui.cancel(
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

	private async handleAcceptedCommentsIfExist(
		pr: PullRequest,
		provider: GitProvider,
	): Promise<void> {
		const commentsAfter = await this.cache.getComments(getPRKey(pr));

		const acceptedComments = commentsAfter.filter(
			(c) => c.status === "accepted",
		);

		if (acceptedComments.length > 0) {
			const shouldSend = await promptToSendCommentsToRemote();

			if (shouldSend) {
				try {
					await this.prWorkflow.postCommentsToRemote(
						pr,
						provider,
						acceptedComments,
					);
					ui.success(
						theme.success(
							`✓ Posted ${acceptedComments.length} accepted comment(s) to the pull request`,
						),
					);
				} catch (error) {
					ui.error(
						theme.error(
							`✗ Failed to post comments to the pull request: ${(error as Error).message}`,
						),
					);
				}
			}
		}
	}

	private async handleComments(prKey: string): Promise<void> {
		await this.commentResolution.handleComments(
			prKey,
			async (comment, prKey, summary) => {
				// Get optional notes for Claude
				const optionalNotes = await this.commentDisplay.promptOptionalNotes();

				// Run the fix session (planning + execution)
				await this.fixSession.runFixSession(
					comment,
					prKey,
					optionalNotes,
					summary,
				);
			},
			async (comment) => {
				await this.commentDisplay.displayCommentWithContext(comment);
			},
		);
	}
}
