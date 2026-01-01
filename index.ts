import * as clack from '@clack/prompts';
import { exit } from 'process';
import type { PullRequest } from './providers/types';
import BitbucketProvider from './providers/bitbucket';
import GitOperations from './git';
import startReview from './graph';

const main = async () => {
  const git = new GitOperations();

  // Step 1: Select remote
  const allRemotes = await git.getRemotes();

  const selectedRemote = await clack.select({
    message: 'Select a remote to work with:',
    options: allRemotes.map((remote) => ({
      label: remote.name,
      value: remote.refs.fetch,
    })),
  });

  // Step 2: Initialize provider and fetch PRs
  const provider = new BitbucketProvider(selectedRemote.toString());
  const prs = await provider.fetchPullRequests();

  // Step 3: Select PR
  const pickedPr = await clack.select({
    message: 'What PR are we working on?',
    options: prs.map((pr) => ({
      label: `${pr.title}`,
      value: pr,
    })),
  });
  const selectedPr = pickedPr as PullRequest;

  // Step 4: Git operations - checkout and get diff
  const currentBranch = await git.getCurrentBranch();

  // We need to make sure we have the latest changes for diff
  await git.pull(selectedRemote.toString());
  // Checkout the source branch of the PR - for review since claude code will read files
  await git.checkout(selectedPr.source.commitHash);

  const fullDiff = await git.getDiff(selectedPr.target.commitHash, selectedPr.source.commitHash);
  const editedFiles = await git.getDiffSummary(
    selectedPr.target.commitHash,
    selectedPr.source.commitHash,
  );
  console.log('Edited files:', editedFiles);

  // Step 5: Fetch commit messages
  const commitMessages = await provider.fetchCommits(selectedPr);
  console.log('Commits fetched from API:', commitMessages);

  // Step 6: Run review
  const res = await startReview({
    commits: commitMessages,
    title: selectedPr.title,
    description: selectedPr.description || '',
    editedFiles,
    sourceHash: selectedPr.source.commitHash,
    sourceName: selectedPr.source.name,
    targetHash: selectedPr.target.commitHash,
    targetName: selectedPr.target.name,
    diff: fullDiff,
  });

  console.log('Review context:', res.context);
  console.log('Review result:', res.result);
  console.log('Review comments:', res.comments);
  console.log('Review completed.');

  // Step 7: Checkout back to the original branch
  // TODO: handle failures too
  await git.checkout(currentBranch);
  exit(1);
};

main();
