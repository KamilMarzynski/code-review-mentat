export type MRBaseData = {
  id: number;
  title: string;
  description: string;
  projectKey: string;
  repoSlug: string;
  pullRequestId: number;
  source: BranchData;
  target: BranchData;
};

export type BranchData = {
  commitHash: string; // TBD how it it's really like
  name: string;
};
