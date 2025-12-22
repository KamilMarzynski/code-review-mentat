import * as clack from '@clack/prompts';
import { fetch } from 'bun';
import { simpleGit } from 'simple-git';
import type { MRBaseData } from './types';
import startReview from './graph';

const { BB_TOKEN } = process.env;
const git = simpleGit();

/**
 * Usage:
 *   node bb-pr-url.ts 'ssh://git@git.viessmann.com:7999/ca/mw-viguide-planning-projects.git'
 *
 * Output:
 *   https://git.viessmann.com/rest/api/1.0/projects/CA/repos/mw-viguide-planning-projects/pull-requests?state=OPEN&limit=50
 */

function buildBitbucketServerMrListUrl(
  sshRemote: string,
  opts: { state?: string; limit?: number } = {},
): string | undefined {
  const state = opts.state ?? 'OPEN';
  const limit = opts.limit ?? 50;

  // Matches: ssh://git@HOST:PORT/PROJECTKEY/repo-slug(.git)?
  const regexpMatchArray = sshRemote.trim().match(
    /^ssh:\/\/git@([^:/]+)(?::(\d+))?\/([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (!regexpMatchArray) {
    return undefined;
  }

  const host = regexpMatchArray[1];
  const projectKey = regexpMatchArray[3]?.toUpperCase();
  const repoSlug = regexpMatchArray[4];

  if (!projectKey || !repoSlug) {
    return undefined;
  }

  // REST base for Bitbucket Data Center
  return `https://${host}/rest/api/1.0/projects/${encodeURIComponent(
    projectKey,
  )}/repos/${encodeURIComponent(
    repoSlug,
  )}/pull-requests?state=${encodeURIComponent(state)}&limit=${encodeURIComponent(
    String(limit),
  )}`;
}

async function fetchMRsFromBitbucketServer(apiUrl: string): Promise<MRBaseData[]> {
  const response = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${BB_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch MRs: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();

  return data.values.map((mrObject: unknown): MRBaseData => ({
    id: (mrObject as any).id,
    title: (mrObject as any).title,
    description: (mrObject as any).description,
    source: {
      name: (mrObject as any).fromRef?.displayId,
      commitHash: (mrObject as any).fromRef?.latestCommit,
    },
    target: {
      name: (mrObject as any).toRef?.displayId,
      commitHash: (mrObject as any).toRef?.latestCommit,
    },
  }));
}

const main = async () => {
  const allRemotes = await git.getRemotes(true);

  const selectedRemote = await clack.select({
    message: 'Select a remote to work with:',
    options: allRemotes.map((remote) => ({
      label: remote.name,
      value: remote.refs.fetch,
    })),
  });

  // TODO: automatically verify which provider is it, check if it's cloud or some hosted server
  // then based on this check try with all matching providers, one of them should work
  // if none works, show an error message to the user

  const fetchMrsUrl = buildBitbucketServerMrListUrl(selectedRemote.toString());

  if (!fetchMrsUrl) {
    throw new Error('Could not build Bitbucket Server PR list URL from the selected remote.');
  }

  const mrs = await fetchMRsFromBitbucketServer(fetchMrsUrl);

  const pickedMr = await clack.select({
    message: 'What MR we are working on?',
    options: mrs.map((pr) => ({
      label: `${pr.title}`, value: pr,
    })),
  });
  const valueOfPickedMr = pickedMr as MRBaseData; // TODO: fix types

  const fullDiff = await git.diff([`${valueOfPickedMr.target.commitHash}...${valueOfPickedMr.source.commitHash}`]);
  const fileNames = await git.diffSummary(['--name-only', `${valueOfPickedMr.target.commitHash}...${valueOfPickedMr.source.commitHash}`]);
  const commitLogs = await git.log({
    from: valueOfPickedMr.target.commitHash,
    to: valueOfPickedMr.source.commitHash,
  });
  const commitMessages = commitLogs.all.map((commit) => commit.message);

  await startReview({
    commits: commitMessages,
    title: valueOfPickedMr.title,
    description: valueOfPickedMr.description || '',
    editedFiles: fileNames.files.map((f) => f.file),
    sourceHash: valueOfPickedMr.source.commitHash,
    sourceName: valueOfPickedMr.source.name,
    targetHash: valueOfPickedMr.target.commitHash,
    targetName: valueOfPickedMr.target.name,
    diff: fullDiff,
  });
};

main();
