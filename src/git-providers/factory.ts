import BitbucketServerGitProvider from "./bitbucket";
import GitHubProvider from "./github";
import type { GitProvider } from "./types";

/**
 * Simple factory for creating git provider instances.
 *
 * Detects the provider from the remote URL:
 * - github.com → GitHubProvider
 * - Everything else → BitbucketServerGitProvider
 */
export class GitProviderFactory {
	create(remote: string): GitProvider {
		if (remote.includes("github.com")) {
			return new GitHubProvider(remote);
		}
		return new BitbucketServerGitProvider(remote);
	}
}
