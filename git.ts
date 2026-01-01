import { simpleGit, type SimpleGit, type RemoteWithRefs } from 'simple-git';

export default class GitOperations {
  private git: SimpleGit;

  constructor() {
    this.git = simpleGit();
  }

  async getRemotes(): Promise<RemoteWithRefs[]> {
    return this.git.getRemotes(true);
  }

  async getCurrentBranch(): Promise<string> {
    const branch = await this.git.branch();
    return branch.current;
  }

  async pull(remote: string): Promise<void> {
    await this.git.pull(remote);
  }

  async checkout(commitOrBranch: string): Promise<void> {
    await this.git.checkout(commitOrBranch);
  }

  async getDiff(fromCommit: string, toCommit: string): Promise<string> {
    return this.git.diff([`${fromCommit}...${toCommit}`]);
  }

  async getDiffSummary(fromCommit: string, toCommit: string): Promise<string[]> {
    const summary = await this.git.diffSummary([
      '--name-only',
      `${fromCommit}...${toCommit}`,
    ]);
    return summary.files.map((f) => f.file);
  }
}
