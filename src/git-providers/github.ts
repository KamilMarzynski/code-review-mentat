import {
	type CreatedPrComment,
	type CreatePullRequestCommentRequest,
	GitProvider,
	type PullRequest,
	type RemoteComment,
	type RemoteInfo,
} from "./types";

const GITHUB_API = "https://api.github.com";

type GitHubPullRequest = {
	number: number;
	title: string;
	body: string | null;
	head: { ref: string; sha: string };
	base: { ref: string; sha: string };
};

type GitHubCommit = {
	commit: { message: string };
};

type GitHubReviewResponse = {
	id: number;
	html_url: string;
};

type GitHubPRComment = {
	id: number;
	user: { login: string };
	body: string;
	path: string;
	line: number | null;
	start_line: number | null;
	html_url: string;
	position: number | null; // null when comment is on an outdated diff hunk
};

type GitHubReviewComment = {
	path: string;
	line: number;
	side: "RIGHT";
	body: string;
};

type GitHubReviewBody = {
	body: string;
	event: "COMMENT";
	comments: GitHubReviewComment[];
};

export default class GitHubProvider extends GitProvider {
	name = "GitHub";

	private remote: RemoteInfo;

	constructor(sshRemote: string) {
		super();
		const parsed = GitHubProvider.parseRemote(sshRemote);
		if (!parsed) {
			throw new Error(`Invalid GitHub SSH remote: ${sshRemote}`);
		}
		this.remote = parsed;
	}

	static parseRemote(sshRemote: string): RemoteInfo | undefined {
		const match = sshRemote
			.trim()
			.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
		if (!match) return undefined;

		const owner = match[1];
		const repo = match[2];

		if (!owner || !repo) return undefined;

		return {
			host: "github.com",
			projectKey: owner,
			repoSlug: repo,
		};
	}

	async fetchPullRequests(): Promise<PullRequest[]> {
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			throw new Error("GITHUB_TOKEN is not set");
		}

		const { projectKey: owner, repoSlug: repo } = this.remote;
		const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&per_page=100`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
		});

		this.handleRateLimit(response);

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error(
					"GitHub authentication failed: GITHUB_TOKEN may be invalid",
				);
			}
			throw new Error(
				`Failed to fetch PRs: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as GitHubPullRequest[];

		return data.map(
			(pr): PullRequest => ({
				id: pr.number,
				title: pr.title,
				description: pr.body ?? "",
				source: { name: pr.head.ref, commitHash: pr.head.sha },
				target: { name: pr.base.ref, commitHash: pr.base.sha },
			}),
		);
	}

	async fetchCommits(pr: PullRequest): Promise<string[]> {
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			throw new Error("GITHUB_TOKEN is not set");
		}

		const { projectKey: owner, repoSlug: repo } = this.remote;
		const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr.id}/commits?per_page=100`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
		});

		this.handleRateLimit(response);

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error(
					"GitHub authentication failed: GITHUB_TOKEN may be invalid",
				);
			}
			throw new Error(
				`Failed to fetch commits: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as GitHubCommit[];
		return data.map((c) => c.commit.message);
	}

	async createPullRequestComment(
		pr: PullRequest,
		comment: CreatePullRequestCommentRequest,
	): Promise<CreatedPrComment> {
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			throw new Error("GITHUB_TOKEN is not set");
		}

		const { projectKey: owner, repoSlug: repo } = this.remote;
		const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr.id}/reviews`;

		const prefix = [
			comment.severity ? `[${comment.severity}]` : null,
			comment.confidence ? `[${comment.confidence} confidence]` : null,
		]
			.filter(Boolean)
			.join(" ");
		const body = prefix ? `${prefix} ${comment.text}` : comment.text;

		const reviewBody: GitHubReviewBody = comment.path
			? {
					body: "",
					event: "COMMENT",
					comments: [
						{
							path: comment.path,
							line: comment.line ?? 1,
							side: "RIGHT",
							body,
						},
					],
				}
			: {
					body,
					event: "COMMENT",
					comments: [],
				};

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(reviewBody),
		});

		this.handleRateLimit(response);

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error(
					"GitHub authentication failed: GITHUB_TOKEN may be invalid",
				);
			}
			throw new Error(
				`Failed to create comment: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as GitHubReviewResponse;
		return { id: data.id, url: data.html_url };
	}

	async fetchPullRequestComments(pr: PullRequest): Promise<RemoteComment[]> {
		const token = process.env.GITHUB_TOKEN;
		if (!token) {
			throw new Error("GITHUB_TOKEN is not set");
		}

		const { projectKey: owner, repoSlug: repo } = this.remote;
		const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr.id}/comments?per_page=100`;

		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
			},
		});

		this.handleRateLimit(response);

		if (!response.ok) {
			if (response.status === 401) {
				throw new Error(
					"GitHub authentication failed: GITHUB_TOKEN may be invalid",
				);
			}
			throw new Error(
				`Failed to fetch PR comments: ${response.status} ${response.statusText}`,
			);
		}

		const data = (await response.json()) as GitHubPRComment[];

		return data.map(
			(c): RemoteComment => ({
				id: String(c.id),
				author: c.user.login,
				content: c.body,
				filePath: c.path || undefined,
				line: c.line ?? undefined,
				startLine: c.start_line ?? undefined,
				url: c.html_url,
				// position === null means the comment is on an outdated diff hunk
				resolved: c.position === null,
			}),
		);
	}

	private handleRateLimit(response: Response): void {
		const isRateLimit =
			response.status === 429 ||
			(response.status === 403 &&
				response.headers.get("x-ratelimit-remaining") === "0");

		if (isRateLimit) {
			const reset = response.headers.get("x-ratelimit-reset");
			const resetTime = reset
				? new Date(Number(reset) * 1000).toISOString()
				: "unknown";
			throw new Error(`GitHub rate limit exceeded. Resets at ${resetTime}`);
		}
	}
}
