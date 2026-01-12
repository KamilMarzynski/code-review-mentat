import {
	type CreatedPrComment,
	type CreatePullRequestCommentRequest,
	GitProvider,
	type PullRequest,
	type RemoteInfo,
} from "./types";

const { BB_TOKEN } = process.env;

enum LineType {
	CONTEXT = "CONTEXT",
	ADDED = "ADDED",
	REMOVED = "REMOVED",
}
enum FileType {
	FROM = "FROM",
	TO = "TO",
}

type CreatePullRequestCommentAnchor = {
	// Required for any anchored comment
	path: string;

	// Line comment fields (optional; if present, it's a line anchor)
	line?: number;
};

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

	async createPullRequestComment(
		pr: PullRequest,
		comment: CreatePullRequestCommentRequest,
	): Promise<CreatedPrComment> {
		if (!BB_TOKEN) {
			throw new Error("BB_TOKEN is not set");
		}

		const url = this.buildPullRequestCommentsUrl(pr);
		const body: any = {
			text: comment.text,
			severity: comment.severity === "risk" ? "BLOCKER" : "NORMAL",
			version: 1,
			threadResolved: false,
		};

		if (comment.parentId != null) {
			body.parent = { id: comment.parentId };
		}

		if (comment.path) {
			body.anchor = this.normalizeAnchor({
				path: comment.path,
				line: comment.line,
			});
		}
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json;charset=UTF-8",
				"Content-Type": "application/json",
				Authorization: `Bearer ${BB_TOKEN}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(
				`Failed to create comment: ${response.status} ${response.statusText}`,
			);
		}

		const data: any = await response.json();

		return {
			id: data.id,
		};
	}

	private normalizeAnchor(anchor: CreatePullRequestCommentAnchor) {
		// path is always required for anchored comments
		if (!anchor.path) {
			throw new Error("anchor.path is required");
		}

		const isLineAnchor = anchor.line != null;

		// Only include defined fields
		return {
			path: anchor.path,
			...(isLineAnchor
				? {
						line: anchor.line,
						lineType: LineType.ADDED,
						fileType: FileType.FROM,
					}
				: {}),
		};
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
		return `https://${this.remote.host}/rest/api/1.0/projects/${encodeURIComponent(
			this.remote.projectKey,
		)}/repos/${encodeURIComponent(this.remote.repoSlug)}/pull-requests`;
	}
}
