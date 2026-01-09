import * as clack from "@clack/prompts";
import type LocalCache from "../cache/local-cache";
import { theme } from "../ui/theme";
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
		clack.intro(theme.primary("Initiating Mentat analysis protocol..."));

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
			const shouldHandleComments =
				await this.commentResolution.checkPendingComments(selectedPr);

			if (shouldHandleComments) {
				await this.handleComments(
					`${selectedPr.source.name}|${selectedPr.target.name}`,
				);
				return;
			}

			// Step 8: Determine cache/context strategy
			const cacheConfig =
				await this.reviewHandler.determineCacheStrategy(selectedPr);

			// Step 9: Process review stream
			const { contextHasError, reviewHasError } =
				await this.reviewHandler.processReviewStream(
					selectedPr,
					commitMessages,
					fullDiff,
					editedFiles,
					cacheConfig,
					async (comments, prKey) => {
						await this.commentResolution.saveCommentsToCache(comments, prKey);
					},
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
				await this.handleComments(
					`${selectedPr.source.name}|${selectedPr.target.name}`,
				);
				return;
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

	private async handleComments(prKey: string): Promise<void> {
		await this.commentResolution.handleComments(
			prKey,
			async (comment, prKey, summary) => {
				// Get optional notes for Claude
				const optionalNotes = await this.commentDisplay.promptOptionalNotes();

				// Get full diff for context
				const fullDiff = await this.commentDisplay.getFullDiff();

				// Run the fix session (planning + execution)
				await this.fixSession.runFixSession(
					comment,
					prKey,
					fullDiff,
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
