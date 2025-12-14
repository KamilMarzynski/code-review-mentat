import * as clack from '@clack/prompts';
import { fetch } from 'bun';
import { simpleGit } from 'simple-git';
import type { PRBaseData } from './types';

const { BB_TOKEN } = process.env;

/**
 * Usage:
 *   node bb-pr-url.ts 'ssh://git@git.viessmann.com:7999/ca/mw-viguide-planning-projects.git'
 *
 * Output:
 *   https://git.viessmann.com/rest/api/1.0/projects/CA/repos/mw-viguide-planning-projects/pull-requests?state=OPEN&limit=50
 */

function buildBitbucketServerPrListUrl(
  sshRemote: string,
  opts: { state?: string; limit?: number } = {},
): string | undefined {
  const state = opts.state ?? 'OPEN';
  const limit = opts.limit ?? 50;

  // Matches: ssh://git@HOST:PORT/PROJECTKEY/repo-slug(.git)?
  const m = sshRemote.trim().match(
    /^ssh:\/\/git@([^:/]+)(?::(\d+))?\/([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (!m) {
    return undefined;
  }

  const host = m[1];
  const projectKey = m[3]?.toUpperCase();
  const repoSlug = m[4];

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

async function fetchPRsFromBitbucketServer(apiUrl: string): Promise<PRBaseData[]> {
  const response = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${BB_TOKEN}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch PRs: ${response.status} ${response.statusText}`);
  }

  const data: any = await response.json();

  return data.values.map((prObject: unknown): PRBaseData => ({
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

const allRemotes = await simpleGit().getRemotes(true);

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

const fetchPrsUrl = buildBitbucketServerPrListUrl(selectedRemote.toString());

if (!fetchPrsUrl) {
  throw new Error('Could not build Bitbucket Server PR list URL from the selected remote.');
}

const prs = await fetchPRsFromBitbucketServer(fetchPrsUrl);

await clack.select({
  message: 'What MR we are working on?',
  options: prs.map((pr) => ({
    label: `${pr.title}`, value: pr,
  })),
});
