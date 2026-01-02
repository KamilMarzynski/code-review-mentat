import * as clack from '@clack/prompts';
import type { PullRequest } from './providers/types';
import BitbucketServerProvider from './providers/bitbucket';
import GitOperations from './git';
import startReview, { type ReviewInput } from './graph';
import ContextCache from './cache';

async function runReview(mrData: ReviewInput) {
  const cache = new ContextCache();
  const cacheInput = { sourceBranch: mrData.sourceName, targetBranch: mrData.targetName };

  const hasCached = cache.has(cacheInput);

  let gatherContext = true;
  let refreshCache = false;

  if (hasCached) {
    const meta = cache.getMetadata(cacheInput);
    console.log('Gathered from commit:', meta?.gatheredFromCommit);
    console.log('Current source commit:', mrData.sourceHash);

    const commitChanged = meta?.gatheredFromCommit !== mrData.sourceHash;

    if (!commitChanged) {
      // Auto-reuse (no prompt)
      clack.log.success('Using cached context (no changes)');
    } else {
      // Commit changed - ask user
      const choice = await clack.select({
        message: 'Commits changed. How to proceed?',
        options: [
          { value: 'use', label: 'Use existing context' },
          { value: 'refresh', label: 'Refresh context' },
          { value: 'skip', label: 'Skip context' },
        ],
      });

      if (choice === 'refresh') {
        refreshCache = true;
      } else if (choice === 'skip') {
        gatherContext = false;
      }
    }
  } else {
    // No cache - ask if should gather
    const shouldGather = await clack.confirm({
      message: 'Gather context from Jira/Confluence?',
    });
    gatherContext = Boolean(shouldGather.valueOf());
  }

  const result = await startReview({
    ...mrData,
    gatherContext,
    refreshCache,
  });

  return result;
}

const main = async () => {
  const git = new GitOperations();
  const currentBranch = await git.getCurrentBranch();

  try {
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
    const provider = new BitbucketServerProvider(selectedRemote.toString());
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

    // Step 4: Fetch commit messages
    const commitMessages = await provider.fetchCommits(selectedPr);
    console.log('Commits fetched from API:', commitMessages);

    // Step 5: Run review
    const res = await runReview({
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

    // Step 6: Checkout back to the original branch
    // TODO: handle failures too
    await git.checkout(currentBranch);
  } catch (error) {
    clack.cancel(`Error: ${(error as Error).message}`);
    throw error; // Re-throw to trigger finally
  } finally {
    try {
      console.log(`\n↩️  Restoring branch: ${currentBranch}`);
      await git.checkout(currentBranch);
    } catch (cleanupError) {
      console.error('⚠️  Failed to restore branch:', cleanupError);
      console.log(`   Please manually run: git checkout ${currentBranch}`);
    }
  }
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
