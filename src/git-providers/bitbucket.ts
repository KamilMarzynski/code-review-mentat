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

type BitbucketRef = {
	displayId: string;
	latestCommit: string;
};

type BitbucketPullRequest = {
	id: number;
	title: string;
	description: string;
	fromRef: BitbucketRef;
	toRef: BitbucketRef;
};

type BitbucketPagedResponse<T> = {
	values: T[];
	size: number;
	isLastPage: boolean;
};

type BitbucketCommit = {
	message: string;
};

type BitbucketCommentResponse = {
	id: number;
	links: { self: [{ href: string }] };
};

type CreatePullRequestCommentBody = {
	text: string;
	severity: string;
	version: number;
	threadResolved: boolean;
	parent?: { id: number };
	anchor?: {
		path: string;
		line?: number;
		lineType?: LineType;
		fileType?: FileType;
	};
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

		const data =
			(await response.json()) as BitbucketPagedResponse<BitbucketPullRequest>;

		return data.values.map(
			(pr): PullRequest => ({
				id: pr.id,
				title: pr.title,
				description: pr.description,
				source: {
					name: pr.fromRef?.displayId,
					commitHash: pr.fromRef?.latestCommit,
				},
				target: {
					name: pr.toRef?.displayId,
					commitHash: pr.toRef?.latestCommit,
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

		const data =
			(await response.json()) as BitbucketPagedResponse<BitbucketCommit>;
		return data.values.map((commit) => commit.message);
	}

	async createPullRequestComment(
		pr: PullRequest,
		comment: CreatePullRequestCommentRequest,
	): Promise<CreatedPrComment> {
		if (!BB_TOKEN) {
			throw new Error("BB_TOKEN is not set");
		}

		const url = this.buildPullRequestCommentsUrl(pr);
		const body: CreatePullRequestCommentBody = {
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

		const data = (await response.json()) as BitbucketCommentResponse;

		return {
			id: data.id,
			url: data.links.self[0]?.href,
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
						fileType: FileType.TO,
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
