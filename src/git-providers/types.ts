export abstract class GitProvider {
	abstract name: string;
	abstract fetchPullRequests(): Promise<PullRequest[]>;
	abstract fetchCommits(pr: PullRequest): Promise<string[]>;
	abstract createPullRequestComment(
		pr: PullRequest,
		comment: CreatePullRequestCommentRequest,
	): Promise<CreatedPrComment>;

	abstract fetchPullRequestComments(pr: PullRequest): Promise<RemoteComment[]>;

	static parseRemote(sshRemote: string): RemoteInfo | undefined {
		const regexpMatchArray = sshRemote
			.trim()
			.match(/^ssh:\/\/git@([^:/]+)(?::(\d+))?\/([^/]+)\/(.+?)(?:\.git)?$/);
		if (!regexpMatchArray) {
			return undefined;
		}

		const host = regexpMatchArray[1];
		const projectKey = regexpMatchArray[3]?.toUpperCase();
		const repoSlug = regexpMatchArray[4];

		if (!host || !projectKey || !repoSlug) {
			return undefined;
		}

		return {
			host,
			projectKey,
			repoSlug,
		};
	}
}

export interface RemoteInfo {
	host: string;
	projectKey: string;
	repoSlug: string;
	// Provider-specific data can be added as additional fields
}

export interface PullRequest {
	id: number;
	title: string;
	description: string;
	source: BranchInfo;
	target: BranchInfo;
	// Provider-specific fields can be added as additional properties
}

export interface BranchInfo {
	name: string;
	commitHash: string;
}

export type CreatePullRequestCommentRequest = {
	text: string;

	// Reply to an existing comment
	parentId?: number;

	// Required for any anchored comment
	path?: string;

	// Line comment fields (optional; if present, it's a line anchor)
	line?: number;

	severity?: "nit" | "suggestion" | "issue" | "risk";
	confidence?: "high" | "medium" | "low";
};

export type CreatedPrComment = {
	id: number;
	url?: string;
};

export interface RemoteComment {
	id: string;
	author: string;
	content: string;
	filePath?: string;
	line?: number;
	startLine?: number;
	url: string;
	resolved: boolean;
}

/**
 * Utility function to generate a consistent PR key for caching and identification
 */
export function getPRKey(pr: PullRequest): string {
	return `${pr.source.name}|${pr.target.name}`;
}
