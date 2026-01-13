import type LocalCache from "../../cache/local-cache";
import { getPRKey, type PullRequest } from "../../git-providers/types";
import type {
	ContextMetadata,
	MenuOption,
	WorkflowAction,
	WorkflowState,
} from "../types";

/**
 * Manages workflow state detection and menu generation
 *
 * Responsibilities:
 * - Detect current workflow state (context, comments, PR status)
 * - Determine available actions based on state
 * - Generate menu options with appropriate hints and recommendations
 */
export class WorkflowStateManager {
	constructor(private cache: LocalCache) {}

	/**
	 * Detect the current workflow state for a pull request
	 */
	async detectState(pr: PullRequest): Promise<WorkflowState> {
		const prKey = getPRKey(pr);
		const cacheInput = {
			sourceBranch: pr.source.name,
			targetBranch: pr.target.name,
		};

		// Check context state
		const hasContext = this.cache.has(cacheInput);
		const cacheMetadata = this.cache.getMetadata(cacheInput);

		let contextMeta: ContextMetadata | undefined;
		if (cacheMetadata) {
			contextMeta = {
				gatheredAt: new Date(cacheMetadata.gatheredAt),
				gatheredFromCommit: cacheMetadata.gatheredFromCommit,
			};
		}

		const contextUpToDate = hasContext
			? cacheMetadata?.gatheredFromCommit === pr.source.commitHash
			: false;

		// Check comments state
		const comments = await this.cache.getComments(prKey);
		const hasComments = comments.length > 0;

		const pendingCount = comments.filter(
			(c) => c.status === "pending" || !c.status,
		).length;
		const acceptedCount = comments.filter(
			(c) => c.status === "accepted",
		).length;
		const fixedCount = comments.filter((c) => c.status === "fixed").length;
		const rejectedCount = comments.filter(
			(c) => c.status === "rejected",
		).length;

		// Check for new commits since last context/review
		const hasNewCommits = contextMeta
			? contextMeta.gatheredFromCommit !== pr.source.commitHash
			: false;

		return {
			hasContext,
			contextUpToDate,
			contextMeta,
			hasComments,
			pendingCount,
			acceptedCount,
			fixedCount,
			rejectedCount,
			hasRemoteComments: false, // Future feature
			remoteCommentsCount: 0, // Future feature
			currentCommit: pr.source.commitHash,
			hasNewCommits,
		};
	}

	/**
	 * Determine which actions are available based on the current state
	 */
	getAvailableActions(state: WorkflowState): WorkflowAction[] {
		const actions: WorkflowAction[] = [];

		// Context gathering - available when no context exists
		if (!state.hasContext) {
			actions.push("gather_context");
		}

		// Context refresh - available when context exists but is outdated
		if (state.hasContext && !state.contextUpToDate) {
			actions.push("refresh_context");
		}

		// Review - always available
		actions.push("run_review");

		// Handle pending comments - only when there are pending comments
		if (state.pendingCount > 0) {
			actions.push("handle_pending");
		}

		// Send accepted comments - only when there are accepted comments
		if (state.acceptedCount > 0) {
			actions.push("send_accepted");
		}

		// Future: Remote comments
		// if (state.hasRemoteComments) {
		//   actions.push("handle_remote");
		// }

		// Exit - always available
		actions.push("exit");

		return actions;
	}

	/**
	 * Generate menu options with hints and recommendations
	 */
	generateMenuOptions(
		state: WorkflowState,
		actions: WorkflowAction[],
	): MenuOption[] {
		const options: MenuOption[] = [];

		for (const action of actions) {
			switch (action) {
				case "gather_context":
					if (!state.hasContext) {
						options.push({
							value: "gather_context",
							label: "🔍 Gather Deep Context",
							hint: "Fetch Jira/Confluence context (enables better review)",
							recommended: true,
						});
					}
					break;

				case "refresh_context":
					if (state.hasContext && !state.contextUpToDate) {
						options.push({
							value: "refresh_context",
							label: "🔄 Refresh Context",
							hint: `Context is outdated (from ${state.contextMeta?.gatheredFromCommit.substring(0, 8)})`,
							recommended: false,
						});
					}
					break;

				case "run_review": {
					const hasWarning = !state.hasContext;
					options.push({
						value: "run_review",
						label: state.hasComments
							? "📝 Run New Review (merge with existing)"
							: "📝 Run Review",
						hint: hasWarning
							? "⚠ No context - review will be limited"
							: state.contextUpToDate
								? "Analyze PR with up-to-date context"
								: "Analyze PR (context available but may be outdated)",
						recommended:
							state.hasContext && state.contextUpToDate && !state.hasComments,
						requiresContext: false,
						warningHint: hasWarning ? "No context available" : undefined,
					});
					break;
				}

				case "handle_pending":
					options.push({
						value: "handle_pending",
						label: `🔧 Handle ${state.pendingCount} Pending Comment${state.pendingCount !== 1 ? "s" : ""}`,
						hint: "Review and resolve comments (fix, accept, or reject)",
						recommended: state.pendingCount > 0,
					});
					break;

				case "send_accepted":
					options.push({
						value: "send_accepted",
						label: `📤 Send ${state.acceptedCount} Accepted Comment${state.acceptedCount !== 1 ? "s" : ""}`,
						hint: "Post accepted comments to pull request",
						recommended: state.acceptedCount > 0 && state.pendingCount === 0,
					});
					break;

				case "handle_remote":
					// Future feature
					if (state.hasRemoteComments) {
						options.push({
							value: "handle_remote",
							label: `💬 Review ${state.remoteCommentsCount} Remote Comment${state.remoteCommentsCount !== 1 ? "s" : ""}`,
							hint: "Review comments from pull request",
							recommended: false,
						});
					}
					break;

				case "exit":
					options.push({
						value: "exit",
						label: "✓ Exit",
						hint: "Save progress and exit",
					});
					break;
			}
		}

		return options;
	}
}
