import {
	type CreatedPrComment,
	type CreatePullRequestCommentRequest,
	GitProvider,
	type PullRequest,
	type RemoteInfo,
} from "./types";

const _GITHUB_API = "https://api.github.com";

type _GitHubPullRequest = {
	number: number;
	title: string;
	body: string | null;
	head: { ref: string; sha: string };
	base: { ref: string; sha: string };
};

type _GitHubCommit = {
	commit: { message: string };
};

type _GitHubReviewResponse = {
	id: number;
};

type _GitHubReviewComment = {
	path: string;
	line: number;
	side: "RIGHT";
	body: string;
};

type _GitHubReviewBody = {
	body: string;
	event: "COMMENT";
	comments: _GitHubReviewComment[];
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

	static parseRemote(_sshRemote: string): RemoteInfo | undefined {
		throw new Error("not implemented");
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
