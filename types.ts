export type MRBaseData = {
  id: number;
  title: string;
  description: string;
  source: BranchData;
  target: BranchData;
};

export type BranchData = {
  commitHash: string; // TBD how it it's really like
  name: string;
};
