import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";
import type { ReviewComment, ReviewCommentWithId } from "../review/types";

/**
 * Cache structure for review context and pending comments
 */
export type CachedContext = {
	context: string;
	meta: {
		// MR identity (stable across commits)
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;

		gatheredAt: string;
		gatheredFromCommit: string; // For reference only

		// Repo identity
		repoPath: string;
		repoRemote?: string;

		version: string;
	};
	comments?: ReviewCommentWithId[];
	reviewedAt?: string;
};

/**
 * Context cache for code review tool
 *
 * Stores:
 * - Deep context from Jira/Confluence (expensive to gather)
 * - Pending review comments (for resumable workflow)
 *
 * Cache location:
 * - macOS: ~/Library/Caches/review-cli/
 * - Linux: ~/.cache/review-cli/
 * - Windows: %LOCALAPPDATA%\review-cli\Cache\
 *
 * Cache key strategy:
 * - Based on MR number or branch names
 * - NOT based on commit hash (context doesn't change with code changes)
 */
export default class LocalCache {
	private readonly cacheDir: string;

	private readonly repoId: string;

	constructor(repoPath: string = process.cwd()) {
		// Get system cache directory
		// macOS: ~/Library/Caches/review-cli/
		// Linux: ~/.cache/review-cli/
		// Windows: %LOCALAPPDATA%\review-cli\Cache\
		const paths = envPaths("review-cli", { suffix: "" });
		this.cacheDir = paths.cache;

		// Generate stable repo identifier (prefer git remote, fallback to path)
		this.repoId = this.getRepoId(repoPath);

		// Create cache directory structure
		const repoCacheDir = join(this.cacheDir, this.repoId);
		if (!existsSync(repoCacheDir)) {
			mkdirSync(repoCacheDir, { recursive: true });
		}
	}

	/**
	 * Generate stable identifier for this repo
	 * Priority: git remote URL > absolute path hash
	 */

	private getRepoId(repoPath: string): string {
		try {
			// Try to get git remote URL (most stable across clones/worktrees)
			const remote = execSync("git config --get remote.origin.url", {
				cwd: repoPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
			}).trim();

			if (remote) {
				// Normalize git@github.com:user/repo.git vs https://github.com/user/repo
				const normalized = remote
					.replace(/^git@([^:]+):/, "https://$1/")
					.replace(/\.git$/, "");
				return createHash("sha256")
					.update(normalized)
					.digest("hex")
					.substring(0, 16);
			}
		} catch {
			// Not a git repo or no remote
		}

		// Fallback: hash of absolute path
		return createHash("sha256").update(repoPath).digest("hex").substring(0, 16);
	}

	/**
	 * Get full path to cache file
	 */
	private getCachePath(key: string): string {
		return join(this.cacheDir, this.repoId, `${key}.json`);
	}

	/**
	 * Generate cache key from MR identity (NOT commit hashes)
	 * If MR number exists, use it. Otherwise use branch names.
	 */

	private getCacheKey(input: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;
	}): string {
		let key: string;

		if (input.mrNumber) {
			// Prefer MR number (stable even if branch names change)
			key = `mr-${input.mrNumber}`;
		} else {
			// Fallback: source → target branch
			key = `${input.sourceBranch}-to-${input.targetBranch}`;
		}

		// Sanitize for filesystem
		return key.replace(/[^a-zA-Z0-9-_]/g, "-");
	}

	/**
	 * Check if cached context exists for this MR
	 */
	has(input: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;
	}): boolean {
		const key = this.getCacheKey(input);
		return existsSync(this.getCachePath(key));
	}

	/**
	 * Get cached context for this MR (null if not found)
	 */
	get(input: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;
	}): string | null {
		const key = this.getCacheKey(input);
		const cachePath = this.getCachePath(key);

		if (!existsSync(cachePath)) {
			return null;
		}

		try {
			const cached: CachedContext = JSON.parse(
				readFileSync(cachePath, "utf-8"),
			);
			return cached.context;
		} catch (e) {
			console.warn(`Cache read failed for ${key}:`, e);
			return null;
		}
	}

	/**
	 * Store context for this MR (overwrites existing)
	 */
	set(
		input: {
			mrNumber?: string;
			sourceBranch: string;
			targetBranch: string;
			currentCommit: string;
		},
		context: string,
		repoPath: string = process.cwd(),
	): void {
		const key = this.getCacheKey(input);
		const cachePath = this.getCachePath(key);

		let repoRemote: string | undefined;
		try {
			repoRemote = execSync("git config --get remote.origin.url", {
				cwd: repoPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "ignore"],
			}).trim();
		} catch {
			// Ignore
		}

		// Preserve existing comments if they exist
		let existingComments: ReviewCommentWithId[] | undefined;
		let existingReviewedAt: string | undefined;
		if (existsSync(cachePath)) {
			try {
				const existing: CachedContext = JSON.parse(
					readFileSync(cachePath, "utf-8"),
				);
				existingComments = existing.comments;
				existingReviewedAt = existing.reviewedAt;
			} catch {
				// Ignore parsing errors
			}
		}

		const cached: CachedContext = {
			context,
			meta: {
				mrNumber: input.mrNumber,
				sourceBranch: input.sourceBranch,
				targetBranch: input.targetBranch,
				gatheredAt: new Date().toISOString(),
				gatheredFromCommit: input.currentCommit,
				repoPath,
				repoRemote,
				version: "1.0",
			},
			comments: existingComments,
			reviewedAt: existingReviewedAt,
		};

		writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf-8");
	}

	/**
	 * Get metadata about cached context (for user prompts)
	 */
	getMetadata(input: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;
	}): CachedContext["meta"] | null {
		const key = this.getCacheKey(input);
		const cachePath = this.getCachePath(key);

		if (!existsSync(cachePath)) {
			return null;
		}

		try {
			const cached: CachedContext = JSON.parse(
				readFileSync(cachePath, "utf-8"),
			);
			return cached.meta;
		} catch {
			return null;
		}
	}

	/**
	 * Clear cache for specific MR
	 */
	clear(input: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;
	}): void {
		const key = this.getCacheKey(input);
		const cachePath = this.getCachePath(key);

		if (existsSync(cachePath)) {
			unlinkSync(cachePath);
		}
	}

	/**
	 * List all cached contexts for this repo
	 */
	listForRepo(): Array<CachedContext["meta"]> {
		const repoCacheDir = join(this.cacheDir, this.repoId);

		if (!existsSync(repoCacheDir)) {
			return [];
		}

		return readdirSync(repoCacheDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					const cached: CachedContext = JSON.parse(
						readFileSync(join(repoCacheDir, f), "utf-8"),
					);
					return cached.meta;
				} catch {
					return null;
				}
			})
			.filter((m): m is CachedContext["meta"] => m !== null);
	}

	/**
	 * Clear all cache for this repo
	 * Returns number of files deleted
	 */
	clearRepo(): number {
		const repoCacheDir = join(this.cacheDir, this.repoId);

		if (!existsSync(repoCacheDir)) {
			return 0;
		}

		const files = readdirSync(repoCacheDir).filter((f) => f.endsWith(".json"));

		files.forEach((f) => {
			unlinkSync(join(repoCacheDir, f));
		});

		return files.length;
	}

	/**
	 * Get path to cache directory (for user reference)
	 */
	getCacheLocation(): string {
		return join(this.cacheDir, this.repoId);
	}

	/**
	 * Get global cache root (all repos)
	 */
	getGlobalCacheLocation(): string {
		return this.cacheDir;
	}

	/**
	 * Save full comments for a PR session
	 * Called immediately after review completes
	 */
	async saveComments(prKey: string, comments: ReviewComment[]): Promise<void> {
		// Parse prKey back into branches
		const [sourceBranch, targetBranch] = prKey.split("|");
		if (!sourceBranch || !targetBranch) {
			throw new Error(`Invalid prKey format: ${prKey}`);
		}

		const key = this.getCacheKey({ sourceBranch, targetBranch });
		const cachePath = this.getCachePath(key);

		// Load existing cache file
		let cached: CachedContext;
		if (existsSync(cachePath)) {
			try {
				cached = JSON.parse(readFileSync(cachePath, "utf-8"));
			} catch {
				// If we can't read the cache, create a minimal structure
				cached = {
					context: "No context available",
					meta: {
						sourceBranch,
						targetBranch,
						gatheredAt: new Date().toISOString(),
						gatheredFromCommit: "unknown",
						repoPath: process.cwd(),
						version: "1.0",
					},
				};
			}
		} else {
			// Create minimal cache structure if no context exists yet
			cached = {
				context: "No context available",
				meta: {
					sourceBranch,
					targetBranch,
					gatheredAt: new Date().toISOString(),
					gatheredFromCommit: "unknown",
					repoPath: process.cwd(),
					version: "1.0",
				},
			};
		}

		// Update comments and reviewedAt timestamp
		cached.comments = comments as ReviewCommentWithId[];
		cached.reviewedAt = new Date().toISOString();

		// Write back to cache
		writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf-8");
	}

	/**
	 * Get all comments for a PR session
	 */
	async getComments(prKey: string): Promise<ReviewCommentWithId[]> {
		// Parse prKey back into branches
		const [sourceBranch, targetBranch] = prKey.split("|");
		if (!sourceBranch || !targetBranch) {
			return [];
		}

		const key = this.getCacheKey({ sourceBranch, targetBranch });
		const cachePath = this.getCachePath(key);

		if (!existsSync(cachePath)) {
			return [];
		}

		try {
			const cached: CachedContext = JSON.parse(
				readFileSync(cachePath, "utf-8"),
			);
			return cached.comments || [];
		} catch {
			return [];
		}
	}

	/**
	 * Update a single comment's data
	 */
	async updateComment(
		prKey: string,
		commentId: string,
		updates: Partial<ReviewCommentWithId>,
	): Promise<void> {
		// Parse prKey back into branches
		const [sourceBranch, targetBranch] = prKey.split("|");
		if (!sourceBranch || !targetBranch) {
			throw new Error(`Invalid prKey format: ${prKey}`);
		}

		const key = this.getCacheKey({ sourceBranch, targetBranch });
		const cachePath = this.getCachePath(key);

		if (!existsSync(cachePath)) {
			throw new Error(`No cache file found for ${prKey}`);
		}

		const cached: CachedContext = JSON.parse(readFileSync(cachePath, "utf-8"));

		if (!cached.comments || cached.comments.length === 0) {
			throw new Error(`No comments found for ${prKey}`);
		}

		const index = cached.comments.findIndex((c) => c.id === commentId);
		if (index === -1) {
			throw new Error(`Comment ${commentId} not found`);
		}

		cached.comments[index] = {
			...cached.comments[index],
			...updates,
		} as ReviewCommentWithId;

		// Write back to cache
		writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf-8");
	}

	async getUnresolvedComments(prKey: string): Promise<ReviewComment[]> {
		const comments = await this.getComments(prKey);
		return comments.filter((c) => c.status === "pending" || !c.status);
	}
}
