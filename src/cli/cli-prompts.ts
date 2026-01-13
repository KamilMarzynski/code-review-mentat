import * as clack from "@clack/prompts";
import type { RemoteWithRefs } from "simple-git";
import type { CachedContext } from "../cache/local-cache";
import type { PullRequest } from "../git-providers/types";
import { theme } from "../ui/theme";
import type { MenuOption, WorkflowAction } from "./types";

export async function promptForRemote(
	remotes: RemoteWithRefs[],
): Promise<string> {
	const selectedRemote = await clack.select({
		message: theme.accent("Select repository remote:"),
		options: remotes.map((remote) => ({
			label:
				theme.primary(`${remote.name}`) +
				theme.muted(` → ${remote.refs.fetch}`),
			value: remote.refs.fetch,
			hint: remote.name === "origin" ? "Primary remote" : undefined,
		})),
	});

	if (clack.isCancel(selectedRemote)) {
		clack.cancel(theme.error("Computation interrupted."));
		process.exit(0);
	}

	return selectedRemote.toString();
}

export async function promptForPR(prs: PullRequest[]): Promise<PullRequest> {
	const pickedPr = await clack.select({
		message: theme.accent("Select pull request to analyze:"),
		options: prs.map((pr) => ({
			label: theme.primary(pr.title),
			value: pr,
			hint: theme.muted(`${pr.source.name} → ${pr.target.name}`),
		})),
	});

	if (clack.isCancel(pickedPr)) {
		clack.cancel(theme.error("Computation interrupted."));
		process.exit(0);
	}

	return pickedPr as PullRequest;
}

export async function promptForCacheStrategy(
	hasCached: boolean,
	meta?: CachedContext["meta"],
	currentHash?: string,
): Promise<{ gatherContext: boolean; refreshCache: boolean }> {
	let gatherContext = true;
	let refreshCache = false;

	if (hasCached) {
		const commitChanged = meta?.gatheredFromCommit !== currentHash;

		if (meta && !commitChanged) {
			clack.log.success(
				theme.success("Deep context already synthesized. ") +
					theme.muted(
						`(computed ${new Date(meta.gatheredAt).toLocaleString()})`,
					),
			);
			// Use cached context, no need to gather again
			gatherContext = false;
		} else {
			clack.log.warn(
				`${theme.warning("⚡ Pattern shift detected in pull request")}\n${theme.muted(`   Previous: ${meta?.gatheredFromCommit?.substring(0, 8)}`)}\n${theme.muted(`   Current:  ${currentHash?.substring(0, 8)}`)}`,
			);

			const choice = await clack.select({
				message: theme.accent("How shall the Mentat proceed?"),
				options: [
					{
						value: "use",
						label: theme.success("⚡ Use existing computation"),
						hint: "Instant analysis (no API calls)",
					},
					{
						value: "refresh",
						label: theme.warning("🔄 Recompute data synthesis"),
						hint: "Fresh data synthesis from Jira/Confluence (costs credits)",
					},
					{
						value: "skip",
						label: theme.muted("⏭  Skip context synthesis"),
						hint: "Code analysis only, no external data",
					},
				],
			});

			if (clack.isCancel(choice)) {
				clack.cancel(theme.error("Mentat computation interrupted."));
				process.exit(0);
			}

			if (choice === "refresh") {
				refreshCache = true;
			} else if (choice === "skip") {
				gatherContext = false;
			}
		}
	} else {
		const shouldGather = await clack.confirm({
			message: theme.accent(
				"Synthesize deep context from Jira and Confluence?",
			),
			initialValue: true,
		});

		if (clack.isCancel(shouldGather)) {
			clack.cancel(theme.error("Mentat computation interrupted."));
			process.exit(0);
		}

		gatherContext = Boolean(shouldGather);
	}

	return { gatherContext, refreshCache };
}

export async function promptForPendingCommentsAction(
	pendingCount: number,
	hasNewCommits: boolean,
): Promise<"handle_comments" | "review"> {
	const action = await clack.select({
		message: "What would you like to do?",
		options: [
			{
				value: "handle_comments",
				label: "🔧 Handle pending comments",
				hint: `Review and resolve ${pendingCount} pending comment(s)`,
			},
			{
				value: "review",
				label: "🔄 Run new review",
				hint: hasNewCommits
					? "Recommended: New commits detected"
					: "Perform fresh review (you'll choose context strategy next)",
			},
		],
	});

	if (clack.isCancel(action)) {
		clack.cancel("Operation cancelled");
		process.exit(0);
	}

	return action as "handle_comments" | "review";
}

export async function promptToResolveComments(): Promise<boolean> {
	const shouldResolve = await clack.confirm({
		message: "Would you like to review and resolve these comments now?",
		initialValue: true,
	});

	if (clack.isCancel(shouldResolve)) {
		return false;
	}

	return Boolean(shouldResolve);
}

export async function promptToSendCommentsToRemote(): Promise<boolean> {
	const shouldSend = await clack.confirm({
		message: "Post accepted comments to the pull request?",
		initialValue: true,
	});

	if (clack.isCancel(shouldSend)) {
		return false;
	}
	return Boolean(shouldSend);
}

export async function promptContinueWithAllResolved(): Promise<boolean> {
	const shouldContinue = await clack.confirm({
		message: "Run a new review?",
		initialValue: false,
	});

	if (clack.isCancel(shouldContinue)) {
		return false;
	}

	return Boolean(shouldContinue);
}

export async function promptCommentAction(): Promise<
	"fix" | "accept" | "reject" | "skip" | "quit" | null
> {
	const action = await clack.select({
		message: theme.primary("What should we do?"),
		options: [
			{
				value: "fix",
				label: "🔧 Fix with Claude",
				hint: "Plan and implement a fix",
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
		return null;
	}

	return action as "fix" | "accept" | "reject" | "skip" | "quit";
}

export async function promptPlanDecision(): Promise<
	"approve" | "refine" | "reject" | null
> {
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
		return null;
	}

	return planDecision as "approve" | "refine" | "reject";
}

export async function promptPlanFeedback(): Promise<string | null> {
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

	return (feedback as string).trim();
}

export async function promptRetryPlanning(): Promise<boolean> {
	const retry = await clack.confirm({
		message: "Try planning again?",
		initialValue: false,
	});

	if (clack.isCancel(retry)) {
		return false;
	}

	return Boolean(retry);
}

export async function promptContinueExecution(
	message: string = "Let Claude continue?",
): Promise<boolean> {
	const continueDecision = await clack.confirm({
		message,
		initialValue: true,
	});

	if (clack.isCancel(continueDecision)) {
		return false;
	}

	return Boolean(continueDecision);
}

export async function promptKeepPartialChanges(): Promise<boolean> {
	const keepPartial = await clack.confirm({
		message: "Keep partial changes?",
		initialValue: false,
	});

	if (clack.isCancel(keepPartial)) {
		return false;
	}

	return Boolean(keepPartial);
}

export async function promptAcceptChanges(): Promise<boolean> {
	const acceptChanges = await clack.confirm({
		message: "Accept these changes?",
		initialValue: true,
	});

	if (clack.isCancel(acceptChanges)) {
		return false;
	}

	return Boolean(acceptChanges);
}

export async function promptRevertChanges(): Promise<boolean> {
	const shouldRevert = await clack.confirm({
		message: "Revert changes made before the error?",
		initialValue: true,
	});

	if (clack.isCancel(shouldRevert)) {
		return false;
	}

	return Boolean(shouldRevert);
}

export async function promptOptionalNotes(): Promise<string | undefined> {
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

/**
 * Display workflow menu with contextual options
 *
 * Features:
 * - Shows recommendations with ⭐
 * - Displays hints for each option
 * - Shows warnings (⚠) for actions that might not be optimal
 * - Handles cancellation gracefully
 *
 * @param options - Array of menu options to display
 * @returns The selected workflow action
 */
export async function promptWorkflowMenu(
	options: MenuOption[],
): Promise<WorkflowAction> {
	// Format options for clack
	const clackOptions = options.map((option) => {
		let label = option.label;

		// Add recommendation indicator
		if (option.recommended) {
			label = `⭐ ${label}`;
		}

		// Format hint with warning if present
		let hint = option.hint;
		if (option.warningHint && hint) {
			hint = theme.warning(hint);
		} else if (hint && option.recommended) {
			hint = theme.success(hint);
		} else if (hint) {
			hint = theme.muted(hint);
		}

		return {
			value: option.value,
			label: option.recommended ? theme.primary(label) : label,
			hint,
		};
	});

	const selectedAction = await clack.select({
		message: theme.accent("What would you like to do?"),
		options: clackOptions,
	});

	if (clack.isCancel(selectedAction)) {
		clack.cancel(theme.error("Operation cancelled."));
		process.exit(0);
	}

	return selectedAction as WorkflowAction;
}
