import * as clack from '@clack/prompts';
import { exit } from 'process';
import GitOperations from '../git/operations';
import type { GitProvider } from '../providers/types';
import { ReviewService } from '../review/review-service';
import ContextCache from '../cache/context-cache';
import { theme } from '../ui/theme';
import { UILogger } from '../ui/logger';
import { displayHeader, displayContext, displayComments } from './display';
import { promptForRemote, promptForPR, promptForCacheStrategy } from './prompts';

export class CLIOrchestrator {
  constructor(
    private git: GitOperations,
    private createProvider: (remote: string) => GitProvider,
    private reviewService: ReviewService,
    private cache: ContextCache,
    private ui: UILogger,
  ) {}

  async run(): Promise<void> {
    displayHeader();

    clack.intro(theme.primary('Initiating Mentat analysis protocol...'));

    const currentBranch = await this.git.getCurrentBranch();

    try {
      // Step 1: Select remote
      const s1 = this.ui.spinner();
      s1.start(theme.muted('Scanning git remotes...'));

      const allRemotes = await this.git.getRemotes();
      s1.stop(theme.success(`✓ Found ${allRemotes.length} remote(s)`));

      const selectedRemote = await promptForRemote(allRemotes);

      // Step 2: Fetch PRs
      const s2 = this.ui.spinner();
      s2.start(theme.muted('Querying pull requests from remote...'));

      const provider = this.createProvider(selectedRemote);
      const prs = await provider.fetchPullRequests();

      s2.stop(theme.success(`✓ Retrieved ${prs.length} pull request(s)`));

      if (prs.length === 0) {
        clack.outro(theme.warning('No pull requests found. Mentat standing by.'));
        process.exit(0);
      }

      // Step 3: Select PR
      const selectedPr = await promptForPR(prs);

      clack.log.step(theme.muted(`Target: ${selectedPr.title}`));
      clack.log.step(theme.muted(`Source: ${selectedPr.source.name} (${selectedPr.source.commitHash.substring(0, 8)})`));
      clack.log.step(theme.muted(`Target: ${selectedPr.target.name} (${selectedPr.target.commitHash.substring(0, 8)})`));

      // Step 4: Prepare repository
      const s3 = this.ui.spinner();
      s3.start(theme.muted('Synchronizing repository state...'));

      await this.git.pull(selectedRemote);
      s3.message(theme.muted('Entering computation state (checking out source)...'));
      await this.git.checkout(selectedPr.source.commitHash);

      s3.stop(theme.success('✓ Repository prepared'));

      // Step 5: Analyze changes
      const s4 = this.ui.spinner();
      s4.start(theme.muted('Computing diff matrix...'));

      const fullDiff = await this.git.getDiff(selectedPr.target.commitHash, selectedPr.source.commitHash);
      const editedFiles = await this.git.getDiffSummary(
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
      const s5 = this.ui.spinner();
      s5.start(theme.muted('Retrieving commit chronology...'));

      const commitMessages = await provider.fetchCommits(selectedPr);
      s5.stop(theme.success(`✓ Processed ${commitMessages.length} commit(s)`));

      console.log(''); // Spacing

      // Step 7: Handle cache strategy
      const cacheInput = { sourceBranch: selectedPr.source.name, targetBranch: selectedPr.target.name };
      const hasCached = this.cache.has(cacheInput);
      const meta = hasCached ? this.cache.getMetadata(cacheInput) : undefined;

      const { gatherContext, refreshCache } = await promptForCacheStrategy(
        hasCached,
        meta || undefined,
        selectedPr.source.commitHash,
      );

      // Step 8: Run Mentat analysis
      const res = await this.reviewService.startReview({
        commits: commitMessages,
        title: selectedPr.title,
        description: selectedPr.description || '',
        editedFiles,
        sourceHash: selectedPr.source.commitHash,
        sourceName: selectedPr.source.name,
        targetHash: selectedPr.target.commitHash,
        targetName: selectedPr.target.name,
        diff: fullDiff,
        gatherContext,
        refreshCache,
      });

      console.log(''); // Spacing

      // Display results
      displayContext(res.context);
      displayComments(res.comments);

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
        const s = this.ui.spinner();
        s.start(theme.muted(`Restoring original state (${currentBranch})...`));
        await this.git.checkout(currentBranch);
        s.stop(theme.success('✓ Repository state restored'));
        exit();
      } catch {
        clack.log.error(
          theme.error('⚠ Failed to restore branch state\n')
          + theme.muted(`   Please manually run: git checkout ${currentBranch}`),
        );
      }
    }
  }
}
