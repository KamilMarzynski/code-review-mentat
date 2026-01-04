import {
  GitProvider, type RemoteInfo, type PullRequest,
} from './types';

const { BB_TOKEN } = process.env;

export default class BitbucketServerProvider implements GitProvider {
  name = 'Bitbucket Server';

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
      throw new Error(`Failed to fetch PRs: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();

    return data.values.map((prObject: unknown): PullRequest => ({
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
    }));
  }

  async fetchCommits(pr: PullRequest): Promise<string[]> {
    const url = this.buildPullRequestCommitsUrl(pr);
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${BB_TOKEN}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch commits: ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();
    return data.values.map((commit: any) => commit.message);
  }

  private buildPullRequestListUrl(
    opts: { state?: string; limit?: number } = {},
  ): string {
    const state = opts.state ?? 'OPEN';
    const limit = opts.limit ?? 50;

    return `https://${this.remote.host}/rest/api/1.0/projects/${encodeURIComponent(
      this.remote.projectKey,
    )}/repos/${encodeURIComponent(
      this.remote.repoSlug,
    )}/pull-requests?state=${encodeURIComponent(state)}&limit=${encodeURIComponent(
      String(limit),
    )}`;
  }

  private buildPullRequestCommitsUrl(pr: PullRequest): string {
    return (
      `https://${this.remote.host}/rest/api/1.0/projects/${encodeURIComponent(
        this.remote.projectKey,
      )}/repos/${encodeURIComponent(
        this.remote.repoSlug,
      )}/pull-requests/${pr.id}/commits`
    );
  }
}
