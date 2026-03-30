import {
	type CreatedPrComment,
	type CreatePullRequestCommentRequest,
	GitProvider,
	type PullRequest,
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
		throw new Error("not implemented");
	}

	async fetchCommits(_pr: PullRequest): Promise<string[]> {
		throw new Error("not implemented");
	}

	async createPullRequestComment(
		_pr: PullRequest,
		_comment: CreatePullRequestCommentRequest,
	): Promise<CreatedPrComment> {
		throw new Error("not implemented");
	}

	private handleRateLimit(_response: Response): void {
		throw new Error("not implemented");
	}
}
