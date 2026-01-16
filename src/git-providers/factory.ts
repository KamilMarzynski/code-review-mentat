import BitbucketServerGitProvider from "./bitbucket";
import type { GitProvider } from "./types";

/**
 * Simple factory for creating git provider instances
 *
 * Currently supports Bitbucket Server. Can be extended to support
 * other providers (GitHub, GitLab, etc.) based on remote URL pattern.
 */
export class GitProviderFactory {
	create(remote: string): GitProvider {
		// For now, we only support Bitbucket Server
		// Future: Could detect provider type from remote URL and instantiate accordingly
		return new BitbucketServerGitProvider(remote);
	}
}
