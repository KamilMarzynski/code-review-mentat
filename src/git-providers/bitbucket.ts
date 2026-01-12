import {
	type CreatedPrComment,
	type CreatePrCommentInput,
	GitProvider,
	type PullRequest,
	type RemoteInfo,
} from "./types";

const { BB_TOKEN } = process.env;

export default class BitbucketServerGitProvider implements GitProvider {
	name = "Bitbucket Server";

	private remote: RemoteInfo;

	constructor(sshRemote: string) {
		const parsed = GitProvider.parseRemote(sshRemote);
		if (!parsed) {
			throw new Error(`Invalid Bitbucket Server SSH remote: ${sshRemote}`);
		}
		this.remote = parsed;
	}

	async fetchPullRequests(): Promise<PullRequest[]> {
		const url = this.buildPullRequestListUrl();
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${BB_TOKEN}`,
			},
		});

		if (!response.ok) {
			throw new Error(
				`Failed to fetch PRs: ${response.status} ${response.statusText}`,
			);
		}

		const data: any = await response.json();

		return data.values.map(
			(prObject: unknown): PullRequest => ({
				id: (prObject as any).id,
				title: (prObject as any).title,
				description: (prObject as any).description,
				source: {
					name: (prObject as any).fromRef?.displayId,
					commitHash: (prObject as any).fromRef?.latestCommit,
				},
				target: {
					name: (prObject as any).toRef?.displayId,
					commitHash: (prObject as any).toRef?.latestCommit,
				},
			}),
		);
	}

	async fetchCommits(pr: PullRequest): Promise<string[]> {
		const url = this.buildPullRequestCommitsUrl(pr);
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${BB_TOKEN}`,
			},
		});

		if (!response.ok) {
			throw new Error(
				`Failed to fetch commits: ${response.status} ${response.statusText}`,
			);
		}

		const data: any = await response.json();
		return data.values.map((commit: any) => commit.message);
	}

	async postComments(
		pr: PullRequest,
		comments: CreatePrCommentInput[],
		opts: { failFast?: boolean } = {},
	): Promise<CreatedPrComment[]> {
		if (!BB_TOKEN) {
			throw new Error("BB_TOKEN is not set");
		}

		const url = this.buildPullRequestCommentsUrl(pr);
		const failFast = opts.failFast ?? true;

		const created: CreatedPrComment[] = [];

		// Sequential preserves comment order on the PR timeline.
		for (const c of comments) {
			const text = typeof c === "string" ? c : c.text;

			const body: any = { text };

			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${BB_TOKEN}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				const msg = `Failed to post comment to PR ${pr.title}: ${response.status} ${response.statusText}${
					errText ? ` - ${errText}` : ""
				}`;
				if (failFast) {
					throw new Error(msg);
				}
				continue;
			}

			const data: any = await response.json();

			created.push({
				id: data.id,
				text: data.text ?? text,
				version: data.version,
			});
		}

		return created;
	}

	private buildPullRequestCommentsUrl(pr: PullRequest): string {
		return `${this.buildPullRequestsUrl()}/${encodeURIComponent(String(pr.id))}/comments`;
	}

	private buildPullRequestListUrl(
		opts: { state?: string; limit?: number } = {},
	): string {
		const state = opts.state ?? "OPEN";
		const limit = opts.limit ?? 50;

		return `${this.buildPullRequestsUrl()}?state=${encodeURIComponent(state)}&limit=${encodeURIComponent(
			String(limit),
		)}`;
	}

	private buildPullRequestCommitsUrl(pr: PullRequest): string {
		return `${this.buildPullRequestsUrl()}/${pr.id}/commits`;
	}

	private buildPullRequestsUrl(): string {
		return `https://${this.remote.host}/projects/${encodeURIComponent(
			this.remote.projectKey,
		)}/repos/${encodeURIComponent(this.remote.repoSlug)}/pull-requests`;
	}
}
