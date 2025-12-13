import * as clack from '@clack/prompts';
import { simpleGit } from 'simple-git';

const allRemotes = await simpleGit().getRemotes(true);

console.log('Available remotes:', allRemotes);

const selectedRemote = await clack.select({
  message: 'Select a remote to work with:',
  options: allRemotes.map((remote) => ({
    label: remote.name,
    value: remote.refs.fetch,
  }))
});

console.log(`Selected remote: ${selectedRemote.toString()}`);

const fetchPrsUrl = buildBitbucketServerPrListUrl(selectedRemote.toString());

console.log(`Fetch PRs URL: ${fetchPrsUrl}`);

const mr = await clack.select({
  message: 'What MR we are working on?',
  options: [
    { label: 'feature/FOO-123 -> dev', value: 'https://example.foo123TOdev.com' },
    { label: 'feature/FOO-456 -> dev', value: 'https://example.foo456TOdev.com' },
  ],
});


console.log(`Selected MR: ${mr.toString()}`);



/**
 * Usage:
 *   node bb-pr-url.ts 'ssh://git@git.viessmann.com:7999/ca/mw-viguide-planning-projects.git'
 *
 * Output:
 *   https://git.viessmann.com/rest/api/1.0/projects/CA/repos/mw-viguide-planning-projects/pull-requests?state=OPEN&limit=50
 */

function buildBitbucketServerPrListUrl(
  sshRemote: string,
  opts: { state?: string; limit?: number } = {}
): string {
  const state = opts.state ?? "OPEN";
  const limit = opts.limit ?? 50;

  // Matches: ssh://git@HOST:PORT/PROJECTKEY/repo-slug(.git)?
  const m = sshRemote.trim().match(
    /^ssh:\/\/git@([^:\/]+)(?::(\d+))?\/([^\/]+)\/(.+?)(?:\.git)?$/
  );
  if (!m) {
    throw new Error(`Unsupported SSH remote format: ${sshRemote}`);
  }

  const host = m[1];
  const projectKey = m[3]?.toUpperCase();
  const repoSlug = m[4];

  if (!projectKey || !repoSlug) {
    throw new Error(`Could not extract project key or repo slug from: ${sshRemote}`);
  }

  // REST base for Bitbucket Data Center
  return `https://${host}/rest/api/1.0/projects/${encodeURIComponent(
    projectKey
  )}/repos/${encodeURIComponent(
    repoSlug
  )}/pull-requests?state=${encodeURIComponent(state)}&limit=${encodeURIComponent(
    String(limit)
  )}`;
}

