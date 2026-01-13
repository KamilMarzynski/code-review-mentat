import type LocalCache from "../cache/local-cache";
import type { GitProvider, PullRequest } from "../git-providers/types";
import { ui } from "../ui/logger";
import { theme } from "../ui/theme";
import { promptWorkflowMenu } from "./cli-prompts";
import { displayHeader } from "./display";
import type { ActionExecutor } from "./managers/action-executor";
import type { CommentDisplayService } from "./managers/comment-display-service";
import type { CommentResolutionManager } from "./managers/comment-resolution-manager";
import type { FixSessionOrchestrator } from "./managers/fix-session-orchestrator";
import type { PostActionHandler } from "./managers/post-action-handler";
import type { PRWorkflowManager } from "./managers/pr-workflow-manager";
import type { ReviewStreamHandler } from "./managers/review-stream-handler";
import type { WorkflowStateManager } from "./managers/workflow-state-manager";
import type { WorkflowAction } from "./types";

/**
 * Setup context returned from initial setup phase
 */
interface SetupContext {
	pr: PullRequest;
	cleanup: () => Promise<void>;
}

export class CLIOrchestrator {
	constructor(
		private prWorkflow: PRWorkflowManager,
		_reviewHandler: ReviewStreamHandler,
		_commentResolution: CommentResolutionManager,
		_fixSession: FixSessionOrchestrator,
		_commentDisplay: CommentDisplayService,
		_cache: LocalCache,
		private stateManager: WorkflowStateManager,
		private actionExecutor: ActionExecutor,
		private postActionHandler: PostActionHandler,
	) {}

	public async run(): Promise<void> {
		displayHeader();
		ui.intro(theme.computation("Mentat analysis protocol initiated"));

		try {
			// Phase 1: Initial Setup
			const context = await this.initialSetup();

			// Phase 2: Main Menu Loop
			await this.menuLoop(context);

			// Phase 3: Cleanup handled in finally block
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
		}
	}

	/**
	 * Phase 1: Initial Setup
	 * - Check workspace
	 * - Select remote and PR
	 * - Prepare repository
	 * - Set up cleanup handlers
	 */
	private async initialSetup(): Promise<SetupContext> {
		// Check for uncommitted changes before proceeding
		const dirtyWorkspace = await this.prWorkflow.checkWorkspaceClean();
		if (dirtyWorkspace) {
			process.exit(1); // Exit cleanly with error code
		}

		const { cleanup } = await this.prWorkflow.setupCleanupHandlers();

		// Remote selection and PR fetching
		const selectedRemote = await this.prWorkflow.selectRemote();
		await this.prWorkflow.setProviderForRemote(selectedRemote);
		const { prs } = await this.prWorkflow.fetchPullRequests();

		// PR selection
		const selectedPr = await this.prWorkflow.selectPullRequest(prs);

		// Repository preparation
		await this.prWorkflow.prepareRepository(selectedRemote, selectedPr);

		return {
			pr: selectedPr,
			cleanup,
		};
	}

	/**
	 * Phase 2: Main Menu Loop
	 * - Detect workflow state
	 * - Show menu
	 * - Execute actions
	 * - Handle post-action flows
	 */
	private async menuLoop(context: SetupContext): Promise<void> {
		let shouldContinue = true;

		try {
			while (shouldContinue) {
				// 1. Detect current state
				const state = await this.stateManager.detectState(context.pr);

				// 2. Get available actions
				const actions = this.stateManager.getAvailableActions(state);

				// 3. Generate menu options
				const options = this.stateManager.generateMenuOptions(state, actions);

				// 4. Show menu and get user choice
				const action = await promptWorkflowMenu(options);

				// 5. Handle exit
				if (action === "exit") {
					shouldContinue = false;
					break;
				}

				// 6. Execute action
				await this.executeAction(action, context, state);

				// 7. Handle post-action smart flow
				const nextAction = await this.handlePostAction(action, context);

				// 8. If next action specified, execute it (smart flow)
				if (nextAction !== "show_menu") {
					await this.executeAction(nextAction, context, state);
				}
			}
		} finally {
			// Always restore branch (for normal exit or errors)
			await context.cleanup();
		}
	}

	/**
	 * Execute a workflow action
	 */
	private async executeAction(
		action: WorkflowAction,
		context: SetupContext,
		_state: unknown, // WorkflowState from state detection (not used directly here)
	): Promise<void> {
		switch (action) {
			case "gather_context":
				await this.actionExecutor.executeGatherContext(context.pr, false);
				break;

			case "refresh_context":
				await this.actionExecutor.executeGatherContext(context.pr, true);
				break;

			case "run_review":
				await this.actionExecutor.executeReview(
					context.pr,
					await this.stateManager.detectState(context.pr),
				);
				break;

			case "handle_pending":
				await this.actionExecutor.executeHandlePending(context.pr);
				break;

			case "send_accepted":
				await this.actionExecutor.executeSendAccepted(context.pr);
				break;

			case "exit":
				// Should not reach here (handled in menuLoop)
				break;

			default:
				throw new Error(`Unknown action: ${action}`);
		}
	}

	/**
	 * Handle post-action flow and return next action or "show_menu"
	 */
	private async handlePostAction(
		action: WorkflowAction,
		context: SetupContext,
	): Promise<WorkflowAction | "show_menu"> {
		switch (action) {
			case "gather_context":
			case "refresh_context":
				return await this.postActionHandler.afterContextGathered(context.pr);

			case "run_review": {
				// We need to get the review result, but ActionExecutor already executed
				// For now, we'll pass a simple result structure
				// This will be improved when we refactor to return results
				const state = await this.stateManager.detectState(context.pr);
				const result = {
					commentsCreated: state.pendingCount,
					hasErrors: false,
				};
				return await this.postActionHandler.afterReviewCompleted(
					result,
					context.pr,
				);
			}

			case "handle_pending": {
				// Similar issue - we'll detect the state to get the result
				const state = await this.stateManager.detectState(context.pr);
				const result = {
					processed: 0, // We don't track this currently
					fixed: state.fixedCount,
					accepted: state.acceptedCount,
					rejected: state.rejectedCount,
					skipped: 0,
				};
				return await this.postActionHandler.afterPendingHandled(
					result,
					context.pr,
				);
			}

			case "send_accepted":
				return await this.postActionHandler.afterAcceptedSent(context.pr);

			default:
				return "show_menu";
		}
	}
}
