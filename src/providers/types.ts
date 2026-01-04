export abstract class GitProvider {
  abstract name: string;
  abstract fetchPullRequests(): Promise<PullRequest[]>;
  abstract fetchCommits(pr: PullRequest): Promise<string[]>;

  static parseRemote(sshRemote: string): RemoteInfo | undefined {
    const regexpMatchArray = sshRemote.trim().match(
      /^ssh:\/\/git@([^:/]+)(?::(\d+))?\/([^/]+)\/(.+?)(?:\.git)?$/,
    );
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
