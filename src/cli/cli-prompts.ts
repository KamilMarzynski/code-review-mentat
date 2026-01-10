import * as clack from "@clack/prompts";
import type { RemoteWithRefs } from "simple-git";
import type { CachedContext } from "../cache/local-cache";
import type { PullRequest } from "../providers/types";
import { theme } from "../ui/theme";

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
		clack.cancel(theme.error("Operation cancelled by user."));
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
		clack.cancel(theme.error("Operation cancelled by user."));
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
				theme.success("Deep context already computed. ") +
					theme.muted(
						`(gathered ${new Date(meta.gatheredAt).toLocaleString()})`,
					),
			);
			// Use cached context, no need to gather again
			gatherContext = false;
		} else {
			clack.log.warn(
				`${theme.warning("⚡ New computations detected in the pull request")}\n${theme.muted(`   Previous: ${meta?.gatheredFromCommit?.substring(0, 8)}`)}\n${theme.muted(`   Current:  ${currentHash?.substring(0, 8)}`)}`,
			);

			const choice = await clack.select({
				message: theme.accent("How shall the Mentat proceed?"),
				options: [
					{
						value: "use",
						label: theme.success("⚡ Use existing deep context"),
						hint: "Instant analysis (no API calls)",
					},
					{
						value: "refresh",
						label: theme.warning("🔄 Recompute deep context"),
						hint: "Fresh data from Jira/Confluence (costs credits)",
					},
					{
						value: "skip",
						label: theme.muted("⏭  Skip context gathering"),
						hint: "Review code only, no external intelligence",
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
			message: theme.accent("Gather deep context from Jira and Confluence?"),
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
): Promise<"handle" | "review"> {
	const action = await clack.select({
		message: "What would you like to do?",
		options: [
			{
				value: "handle",
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

	return action as "handle" | "review";
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
