import * as clack from '@clack/prompts';
import type { PullRequest } from './providers/types';
import BitbucketServerProvider from './providers/bitbucket';
import GitOperations from './git';
import startReview, { type ReviewInput } from './graph';
import ContextCache from './cache';
import { theme, ui } from './ui';

function printMentatHeader() {
  console.log('');
  console.log(theme.primary('╔═══════════════════════════════════════════════════════════════╗'));
  console.log(theme.primary('║') + theme.accent('                    CODE REVIEW MENTAT                         ') + theme.primary('║'));
  console.log(theme.primary('║') + theme.muted('              "It is by will alone I set my mind in motion"    ') + theme.primary('║'));
  console.log(theme.primary('╚═══════════════════════════════════════════════════════════════╝'));
  console.log('');
}

async function runReview(mrData: ReviewInput) {
  const cache = new ContextCache();
  const cacheInput = { sourceBranch: mrData.sourceName, targetBranch: mrData.targetName };

  const hasCached = cache.has(cacheInput);

  let gatherContext = true;
  let refreshCache = false;

  if (hasCached) {
    const meta = cache.getMetadata(cacheInput);
    const commitChanged = meta?.gatheredFromCommit !== mrData.sourceHash;

    if (!commitChanged) {
      clack.log.success(
        theme.success('Deep context already computed. ')
        + theme.muted(`(gathered ${new Date(meta.gatheredFromCommit).toLocaleString()})`),
      );
    } else {
      clack.log.warn(
        `${theme.warning('⚡ New computations detected in the pull request')}\n${
          theme.muted(`   Previous: ${meta?.gatheredFromCommit?.substring(0, 8)}`)}\n${
          theme.muted(`   Current:  ${mrData.sourceHash.substring(0, 8)}`)}`,
      );

      const choice = await clack.select({
        message: theme.accent('How shall the Mentat proceed?'),
        options: [
          {
            value: 'use',
            label: theme.success('⚡ Use existing deep context'),
            hint: 'Instant analysis (no API calls)',
          },
          {
            value: 'refresh',
            label: theme.warning('🔄 Recompute deep context'),
            hint: 'Fresh data from Jira/Confluence (costs credits)',
          },
          {
            value: 'skip',
            label: theme.muted('⏭  Skip context gathering'),
            hint: 'Review code only, no external intelligence',
          },
        ],
      });

      if (clack.isCancel(choice)) {
        clack.cancel(theme.error('Mentat computation interrupted.'));
        process.exit(0);
      }

      if (choice === 'refresh') {
        refreshCache = true;
      } else if (choice === 'skip') {
        gatherContext = false;
      }
    }
  } else {
    const shouldGather = await clack.confirm({
      message: theme.accent('Gather deep context from Jira and Confluence?'),
      initialValue: true,
    });

    if (clack.isCancel(shouldGather)) {
      clack.cancel(theme.error('Mentat computation interrupted.'));
      process.exit(0);
    }

    gatherContext = Boolean(shouldGather);
  }

  // Run the review with themed spinner
  const s = ui.spinner();
  s.start(theme.accent('Mentat is computing...'));

  try {
    const result = await startReview({
      ...mrData,
      gatherContext,
      refreshCache,
    });

    s.stop(theme.success('✓ Computation complete'));
    return result;
  } catch (error) {
    s.stop(theme.error('✗ Computation failed'));
    throw error;
  }
}

const main = async () => {
  printMentatHeader();

  clack.intro(theme.primary('Initiating Mentat analysis protocol...'));

  const git = new GitOperations();
  const currentBranch = await git.getCurrentBranch();

  try {
    // Step 1: Select remote
    const s1 = ui.spinner();
    s1.start(theme.muted('Scanning git remotes...'));

    const allRemotes = await git.getRemotes();
    s1.stop(theme.success(`✓ Found ${allRemotes.length} remote(s)`));

    const selectedRemote = await clack.select({
      message: theme.accent('Select repository remote:'),
      options: allRemotes.map((remote) => ({
        label: theme.primary(`${remote.name}`) + theme.muted(` → ${remote.refs.fetch}`),
        value: remote.refs.fetch,
        hint: remote.name === 'origin' ? 'Primary remote' : undefined,
      })),
    });

    if (clack.isCancel(selectedRemote)) {
      clack.cancel(theme.error('Operation cancelled by user.'));
      process.exit(0);
    }

    // Step 2: Fetch PRs
    const s2 = ui.spinner();
    s2.start(theme.muted('Querying pull requests from remote...'));

    const provider = new BitbucketServerProvider(selectedRemote.toString());
    const prs = await provider.fetchPullRequests();

    s2.stop(theme.success(`✓ Retrieved ${prs.length} pull request(s)`));

    if (prs.length === 0) {
      clack.outro(theme.warning('No pull requests found. Mentat standing by.'));
      process.exit(0);
    }

    // Step 3: Select PR
    const pickedPr = await clack.select({
      message: theme.accent('Select pull request to analyze:'),
      options: prs.map((pr) => ({
        label: theme.primary(pr.title),
        value: pr,
        hint: theme.muted(`${pr.source.name} → ${pr.target.name}`),
      })),
    });

    if (clack.isCancel(pickedPr)) {
      clack.cancel(theme.error('Operation cancelled by user.'));
      process.exit(0);
    }

    const selectedPr = pickedPr as PullRequest;

    clack.log.step(theme.muted(`Target: ${selectedPr.title}`));
    clack.log.step(theme.muted(`Source: ${selectedPr.source.name} (${selectedPr.source.commitHash.substring(0, 8)})`));
    clack.log.step(theme.muted(`Target: ${selectedPr.target.name} (${selectedPr.target.commitHash.substring(0, 8)})`));

    // Step 4: Prepare repository
    const s3 = ui.spinner();
    s3.start(theme.muted('Synchronizing repository state...'));

    await git.pull(selectedRemote.toString());
    s3.message(theme.muted('Entering computation state (checking out source)...'));
    await git.checkout(selectedPr.source.commitHash);

    s3.stop(theme.success('✓ Repository prepared'));

    // Step 5: Analyze changes
    const s4 = ui.spinner();
    s4.start(theme.muted('Computing diff matrix...'));

    const fullDiff = await git.getDiff(selectedPr.target.commitHash, selectedPr.source.commitHash);
    const editedFiles = await git.getDiffSummary(
      selectedPr.target.commitHash,
      selectedPr.source.commitHash,
    );

    s4.stop(theme.success(`✓ Analyzed ${editedFiles.length} file(s)`));

    clack.log.info(
      theme.muted('Modified files: ')
      + theme.secondary(editedFiles.slice(0, 5).join(', '))
      + (editedFiles.length > 5 ? theme.muted(` (+${editedFiles.length - 5} more)`) : ''),
    );

    // Step 6: Fetch commit history
    const s5 = ui.spinner();
    s5.start(theme.muted('Retrieving commit chronology...'));

    const commitMessages = await provider.fetchCommits(selectedPr);
    s5.stop(theme.success(`✓ Processed ${commitMessages.length} commit(s)`));

    console.log(''); // Spacing

    // Step 7: Run Mentat analysis
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

    console.log(''); // Spacing

    // Display results
    clack.note(
      theme.primary('Deep Context:\n')
      + theme.muted(res.context || 'No context gathered'),
      theme.accent('🧠 Mentat Analysis'),
    );

    if (res.comments && res.comments.length > 0) {
      clack.log.warn(theme.warning(`⚠ Found ${res.comments.length} observation(s):`));

      res.comments.slice(0, 3).forEach((comment, i) => {
        console.log(
          theme.muted(`  ${i + 1}. `)
          + theme.secondary(`${comment.file}:${comment.line || '?'}`)
          + theme.muted(` [${comment.severity?.toUpperCase()}]`),
        );
        console.log(theme.muted(`     ${comment.message.substring(0, 80)}${comment.message.length > 80 ? '...' : ''}`));
      });

      if (res.comments.length > 3) {
        console.log(theme.muted(`  ... and ${res.comments.length - 3} more`));
      }
    } else {
      clack.log.success(theme.success('✓ No issues detected. Code quality acceptable.'));
    }

    console.log(''); // Spacing
    clack.outro(
      theme.primary('⚡ Mentat computation complete. ')
      + theme.muted('The analysis is now in your hands.'),
    );
  } catch (error) {
    clack.cancel(
      theme.error('✗ Mentat encountered an error:\n')
      + theme.muted(`   ${(error as Error).message}`),
    );
    throw error;
  } finally {
    // Always restore branch
    try {
      const s = ui.spinner();
      s.start(theme.muted(`Restoring original state (${currentBranch})...`));
      await git.checkout(currentBranch);
      s.stop(theme.success('✓ Repository state restored'));
    } catch (cleanupError) {
      clack.log.error(
        theme.error('⚠ Failed to restore branch state\n')
        + theme.muted(`   Please manually run: git checkout ${currentBranch}`),
      );
    }
  }
};

main().catch((error) => {
  console.error(theme.error('\n✗ Fatal error:'), error);
  process.exit(1);
});
