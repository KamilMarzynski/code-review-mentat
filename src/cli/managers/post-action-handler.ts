import * as clack from "@clack/prompts";
import type { PullRequest } from "../../git-providers/types";
import { ui } from "../../ui/logger";
import { theme } from "../../ui/theme";
import type {
	HandleCommentsResult,
	ReviewResult,
	WorkflowAction,
} from "../types";
import type { WorkflowStateManager } from "./workflow-state-manager";

/**
 * Handles smart prompts after specific workflow actions
 *
 * Responsibilities:
 * - Determine optimal next action based on action result and state
 * - Prompt user for smart flow transitions
 * - Return next action or indicate menu should be shown
 *
 * Smart Flow Examples:
 * - After context → Prompt to run review
 * - After review → Prompt to handle pending comments
 * - After handling → Prompt to send accepted comments
 * - After sending → Always show menu
 */
export class PostActionHandler {
	constructor(private stateManager: WorkflowStateManager) {}

	/**
	 * Handle post-action flow after context gathering
	 *
	 * Logic:
	 * - Show success message
	 * - If no pending comments: Prompt "Run review now with this context?"
	 *   - Yes → Execute review
	 *   - No → Show menu
	 * - If has pending comments: Prompt "Context can help with handling comments. What next?"
	 *   - Handle pending comments
	 *   - Run new review
	 *   - Show menu
	 */
	async afterContextGathered(
		pr: PullRequest,
	): Promise<WorkflowAction | "show_menu"> {
		// Detect new state
		const state = await this.stateManager.detectState(pr);

		if (state.pendingCount === 0) {
			// No pending comments - simple prompt
			const shouldReview = await clack.confirm({
				message: theme.accent("Run review now with this context?"),
				initialValue: true,
			});

			if (clack.isCancel(shouldReview)) {
				return "show_menu";
			}

			return shouldReview ? "run_review" : "show_menu";
		}

		// Has pending comments - offer options
		const nextAction = await clack.select<WorkflowAction | "show_menu">({
			message: theme.accent(
				"Context can help with handling comments. What next?",
			),
			options: [
				{
					value: "handle_pending",
					label: `🔧 Handle ${state.pendingCount} Pending Comment${state.pendingCount !== 1 ? "s" : ""}`,
					hint: "Use new context to resolve comments",
				},
				{
					value: "run_review",
					label: "📝 Run New Review",
					hint: "Analyze PR with context (merge with existing comments)",
				},
				{
					value: "show_menu",
					label: "↩️  Back to Menu",
				},
			],
		});

		if (clack.isCancel(nextAction)) {
			return "show_menu";
		}

		return nextAction;
	}

	/**
	 * Handle post-action flow after review completes
	 *
	 * Logic:
	 * - Show review summary
	 * - If created new pending comments: Prompt "Review complete. Handle pending comments now?"
	 *   - Yes → Execute handle pending
	 *   - No → Show menu
	 * - If no new comments: Show menu
	 */
	async afterReviewCompleted(
		result: ReviewResult,
		pr: PullRequest,
	): Promise<WorkflowAction | "show_menu"> {
		// Show review summary
		if (result.hasErrors) {
			ui.error("Review completed with errors");
		} else if (result.commentsCreated === 0) {
			ui.success("Review complete - no issues found");
			return "show_menu";
		} else {
			ui.success(
				`Review complete - created ${result.commentsCreated} comment${result.commentsCreated !== 1 ? "s" : ""}`,
			);
		}

		// Detect new state to get pending count
		const state = await this.stateManager.detectState(pr);

		if (state.pendingCount === 0) {
			// No pending comments to handle
			return "show_menu";
		}

		// Prompt to handle pending comments
		const shouldHandle = await clack.confirm({
			message: theme.accent(
				`Handle ${state.pendingCount} pending comment${state.pendingCount !== 1 ? "s" : ""} now?`,
			),
			initialValue: true,
		});

		if (clack.isCancel(shouldHandle)) {
			return "show_menu";
		}

		return shouldHandle ? "handle_pending" : "show_menu";
	}

	/**
	 * Handle post-action flow after handling pending comments
	 *
	 * Logic:
	 * - Show resolution summary
	 * - If has accepted comments: Prompt "Send accepted comments to remote?"
	 *   - Yes → Execute send accepted
	 *   - No → Show menu
	 * - If no accepted: Show menu
	 */
	async afterPendingHandled(
		result: HandleCommentsResult,
		pr: PullRequest,
	): Promise<WorkflowAction | "show_menu"> {
		// Show resolution summary
		this.displayResolutionSummary(result);

		// Detect new state to get accepted count
		const state = await this.stateManager.detectState(pr);

		if (state.acceptedCount === 0) {
			// No accepted comments to send
			return "show_menu";
		}

		// Prompt to send accepted comments
		const shouldSend = await clack.confirm({
			message: theme.accent(
				`Send ${state.acceptedCount} accepted comment${state.acceptedCount !== 1 ? "s" : ""} to remote?`,
			),
			initialValue: true,
		});

		if (clack.isCancel(shouldSend)) {
			return "show_menu";
		}

		return shouldSend ? "send_accepted" : "show_menu";
	}

	/**
	 * Handle post-action flow after sending accepted comments
	 *
	 * Logic:
	 * - Show success message
	 * - Always show menu
	 */
	async afterAcceptedSent(_pr: PullRequest): Promise<"show_menu"> {
		ui.success("Comments sent to pull request");

		// Always show menu after sending
		return "show_menu";
	}

	/**
	 * Display resolution summary after handling comments
	 */
	private displayResolutionSummary(result: HandleCommentsResult): void {
		const parts: string[] = [];

		if (result.fixed > 0) {
			parts.push(`${result.fixed} fixed`);
		}
		if (result.accepted > 0) {
			parts.push(`${result.accepted} accepted`);
		}
		if (result.rejected > 0) {
			parts.push(`${result.rejected} rejected`);
		}
		if (result.skipped > 0) {
			parts.push(`${result.skipped} skipped`);
		}

		if (parts.length === 0) {
			ui.info("No comments processed");
		} else {
			ui.success(`Processed ${result.processed} comments: ${parts.join(", ")}`);
		}
	}
}
