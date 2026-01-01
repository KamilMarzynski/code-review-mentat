export interface GitProvider {
  name: string;
  fetchPullRequests(): Promise<PullRequest[]>;
  fetchCommits(pr: PullRequest): Promise<string[]>;
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
