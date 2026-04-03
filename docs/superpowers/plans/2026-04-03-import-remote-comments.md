# Import Remote Comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch reviewer comments from GitHub/Bitbucket PRs and surface them in the CLI so the user can fix, dismiss, or create memories from them without running an AI review first.

**Architecture:** New `CommentImporter` module fetches + normalises + deduplicates remote comments into the existing `LocalCache`. The `handle_remote` action (already stubbed throughout the workflow) is fully wired. Imported comments flow through a new `handleImportedComments` path in `CommentResolutionManager` with a different action set (fix / dismiss / create memory / skip) — no accept/post, since the comment already lives on the remote.

**Tech Stack:** Bun, TypeScript strict, Biome linter, `@clack/prompts` for CLI interactions, provider-native REST APIs (no new packages required).

---

## File Map

| File | Change |
|---|---|
| `src/review/types.ts` | Add `"imported"` to status; add `ImportMetadata`, `ImportedComment`, `GeneratedComment`, `AnyStoredComment`; add type guards |
| `src/git-providers/types.ts` | Add `RemoteComment` interface; add abstract `fetchPullRequestComments` to `GitProvider` |
| `src/git-providers/github.ts` | Stub → implement `fetchPullRequestComments` |
| `src/git-providers/bitbucket.ts` | Stub → implement `fetchPullRequestComments` |
| `src/cache/local-cache.ts` | Add `importedAt` to `CachedContext.meta`; add `setImportedAt` method |
| `src/review/comment-importer.ts` | **New** — fetch, normalise, deduplicate, merge |
| `tests/comment-importer.test.ts` | **New** — unit tests for CommentImporter |
| `src/cli/types.ts` | Add `importedPendingCount` to `WorkflowState` |
| `src/cli/managers/workflow-state-manager.ts` | Populate `hasRemoteComments`, `remoteCommentsCount`, `importedPendingCount`; uncomment `handle_remote` in actions; update menu label |
| `src/cli/managers/pr-workflow-manager.ts` | Add `getProvider()` accessor |
| `src/cli/cli-prompts.ts` | Add `promptImportedCommentAction` |
| `src/cli/managers/comment-resolution-manager.ts` | Add `handleImportedComments` method |
| `src/cli/managers/action-executor.ts` | Add `CommentImporter` dep; implement `executeHandleRemote` |
| `src/cli/orchestrator.ts` | Add `handle_remote` case to `executeAction` |
| `src/index.ts` | Instantiate `CommentImporter`; add to `ActionExecutor` constructor |
| `package.json` | Add `"test": "bun test"` script |

---

## Task 1: Type System Foundation

**Files:**
- Modify: `src/review/types.ts`

- [ ] **Step 1: Add `"imported"` to `ReviewCommentStatus` and the new types**

Replace the `ReviewCommentStatus` type and `StoredReviewComment` type, then append new types at the bottom of the file. The complete updated section:

```typescript
// In src/review/types.ts, replace lines 4-31 with:

export type ReviewCommentStatus =
	| "pending" // Not yet addressed
	| "fixed" // Fixed and accepted
	| "accepted" // Accepted as-is
	| "rejected" // Rejected
	| "posted" // Posted to remote PR
	| "imported"; // Fetched from remote reviewer

export type ReviewComment = {
	id?: string;
	file: string;
	line?: number;
	startLine?: number;
	endLine?: number;
	severity?: "nit" | "suggestion" | "issue" | "risk";
	message: string;
	rationale?: string;
	status: ReviewCommentStatus;
	confidence?: "high" | "medium" | "low";
	verifiedBy?: string;
	memoryCreated?: boolean;
};

export type ImportMetadata = {
	remoteId: string; // provider's comment ID
	remoteAuthor: string; // reviewer's username
	remoteUrl: string; // permalink to original comment
	importedAt: string; // ISO timestamp of fetch
	resolvedOnRemote: boolean; // whether comment is resolved on remote
};

export type StoredReviewComment = ReviewComment & {
	id: string;
	codeSnippet?: string;
	remoteCommentId?: number; // outbound: ID after posting agent comment
	remoteCommentUrl?: string; // outbound: URL after posting agent comment
	source?: "generated" | "imported";
	importMeta?: ImportMetadata;
};

export type GeneratedComment = StoredReviewComment & {
	source: "generated";
	status: "pending" | "accepted" | "fixed" | "rejected" | "posted";
	importMeta?: never;
};

export type ImportedComment = StoredReviewComment & {
	source: "imported";
	status: "imported" | "fixed" | "rejected";
	importMeta: ImportMetadata;
};

export type AnyStoredComment = GeneratedComment | ImportedComment;

export function isImportedComment(
	c: StoredReviewComment,
): c is ImportedComment {
	return c.source === "imported" && c.importMeta != null;
}

export function isGeneratedComment(
	c: StoredReviewComment,
): c is GeneratedComment {
	return c.source !== "imported";
}
```

- [ ] **Step 2: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/review/types.ts
git commit -m "feat: add imported status, ImportMetadata, discriminated comment union"
```

---

## Task 2: Provider Layer — RemoteComment + Abstract Method + Stubs

**Files:**
- Modify: `src/git-providers/types.ts`
- Modify: `src/git-providers/github.ts`
- Modify: `src/git-providers/bitbucket.ts`

- [ ] **Step 1: Add `RemoteComment` and abstract method to `src/git-providers/types.ts`**

After the existing `CreatedPrComment` type (line 74), add:

```typescript
export interface RemoteComment {
	id: string;
	author: string;
	content: string;
	filePath?: string;
	line?: number;
	startLine?: number;
	url: string;
	resolved: boolean;
}
```

Inside the `GitProvider` abstract class, add after `createPullRequestComment`:

```typescript
abstract fetchPullRequestComments(pr: PullRequest): Promise<RemoteComment[]>;
```

- [ ] **Step 2: Add stub to `src/git-providers/github.ts`**

Add inside `GitHubProvider` class (after `createPullRequestComment`):

```typescript
async fetchPullRequestComments(_pr: PullRequest): Promise<RemoteComment[]> {
	throw new Error("fetchPullRequestComments not yet implemented for GitHub");
}
```

Also add `RemoteComment` to the import at the top:

```typescript
import {
	type CreatedPrComment,
	type CreatePullRequestCommentRequest,
	GitProvider,
	type PullRequest,
	type RemoteComment,
	type RemoteInfo,
} from "./types";
```

- [ ] **Step 3: Add stub to `src/git-providers/bitbucket.ts`**

Add inside `BitbucketServerGitProvider` class (after `createPullRequestComment`):

```typescript
async fetchPullRequestComments(_pr: PullRequest): Promise<RemoteComment[]> {
	throw new Error(
		"fetchPullRequestComments not yet implemented for Bitbucket Server",
	);
}
```

Also add `RemoteComment` to the import at the top:

```typescript
import {
	type CreatedPrComment,
	type CreatePullRequestCommentRequest,
	GitProvider,
	type PullRequest,
	type RemoteComment,
	type RemoteInfo,
} from "./types";
```

- [ ] **Step 4: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/git-providers/types.ts src/git-providers/github.ts src/git-providers/bitbucket.ts
git commit -m "feat: add RemoteComment type and abstract fetchPullRequestComments to GitProvider"
```

---

## Task 3: Cache Extension

**Files:**
- Modify: `src/cache/local-cache.ts`

- [ ] **Step 1: Add `importedAt` to `CachedContext.meta`**

In `CachedContext` type (around line 19), add to the `meta` object:

```typescript
export type CachedContext = {
	context: string;
	meta: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;

		gatheredAt: string;
		gatheredFromCommit: string;

		repoPath: string;
		repoRemote?: string;

		importedAt?: string; // ISO timestamp of last successful remote comment import

		version: string;
	};
	comments?: StoredReviewComment[];
	reviewedAt?: string;
	memories?: MemorySearchResult[];
	memoriesRetrievedAt?: string;
};
```

- [ ] **Step 2: Add `setImportedAt` method**

Add this method to the `LocalCache` class after `saveMemories` (around line 322):

```typescript
/**
 * Record the timestamp of the last successful remote comment import
 */
setImportedAt(
	input: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;
	},
	timestamp: string,
): void {
	const key = this.getCacheKey(input);
	const cachePath = this.getCachePath(key);

	if (!existsSync(cachePath)) {
		return;
	}

	try {
		const cached: CachedContext = JSON.parse(
			readFileSync(cachePath, "utf-8"),
		);
		cached.meta.importedAt = timestamp;
		writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf-8");
	} catch {
		// Ignore — non-critical
	}
}
```

- [ ] **Step 3: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cache/local-cache.ts
git commit -m "feat: add importedAt to cache meta and setImportedAt method"
```

---

## Task 4: CommentImporter (TDD)

**Files:**
- Create: `src/review/comment-importer.ts`
- Create: `tests/comment-importer.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add test script to `package.json`**

In the `scripts` block, add:

```json
"test": "bun test"
```

- [ ] **Step 2: Write the failing tests**

Create `tests/comment-importer.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CommentImporter } from "../src/review/comment-importer";
import type {
	AnyStoredComment,
	ImportedComment,
} from "../src/review/types";
import type { GitProvider, RemoteComment } from "../src/git-providers/types";
import type { PullRequest } from "../src/git-providers/types";

// ── Test doubles ──────────────────────────────────────────────────────────────

function makeCache(existing: AnyStoredComment[] = []) {
	const store: AnyStoredComment[] = [...existing];
	let savedImportedAt: string | undefined;

	return {
		async getComments(_prKey: string): Promise<AnyStoredComment[]> {
			return store;
		},
		async saveComments(
			_prKey: string,
			comments: AnyStoredComment[],
		): Promise<void> {
			store.length = 0;
			store.push(...comments);
		},
		setImportedAt(
			_input: { sourceBranch: string; targetBranch: string },
			timestamp: string,
		): void {
			savedImportedAt = timestamp;
		},
		// Inspection helpers
		get comments() {
			return store;
		},
		get importedAt() {
			return savedImportedAt;
		},
	};
}

function makeProvider(comments: RemoteComment[]): Pick<GitProvider, "name" | "fetchPullRequestComments"> {
	return {
		name: "TestProvider",
		fetchPullRequestComments: async () => comments,
	};
}

const testPR: PullRequest = {
	id: 1,
	title: "Test PR",
	description: "",
	source: { name: "feat/foo", commitHash: "abc123" },
	target: { name: "main", commitHash: "def456" },
};

const testRemoteComment: RemoteComment = {
	id: "rc-1",
	author: "reviewer",
	content: "Fix this.",
	filePath: "src/main.ts",
	line: 42,
	url: "https://github.com/org/repo/pull/1#discussion-123",
	resolved: false,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CommentImporter", () => {
	test("reports fetched/added counts on fresh import", async () => {
		const cache = makeCache();
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		const result = await importer.importForPR(
			provider as never,
			testPR,
		);

		expect(result.fetched).toBe(1);
		expect(result.added).toBe(1);
		expect(result.updated).toBe(0);
	});

	test("normalises remote comment to ImportedComment shape", async () => {
		const cache = makeCache();
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		await importer.importForPR(provider as never, testPR);

		const saved = cache.comments[0] as ImportedComment;
		expect(saved.source).toBe("imported");
		expect(saved.status).toBe("imported");
		expect(saved.file).toBe("src/main.ts");
		expect(saved.line).toBe(42);
		expect(saved.message).toBe("Fix this.");
		expect(saved.importMeta.remoteId).toBe("rc-1");
		expect(saved.importMeta.remoteAuthor).toBe("reviewer");
		expect(saved.importMeta.resolvedOnRemote).toBe(false);
		expect(saved.id).toBeTruthy(); // UUID assigned
	});

	test("records importedAt timestamp on cache", async () => {
		const cache = makeCache();
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		await importer.importForPR(provider as never, testPR);

		expect(cache.importedAt).toBeTruthy();
		expect(() => new Date(cache.importedAt!)).not.toThrow();
	});

	test("re-import leaves fixed imported comments untouched", async () => {
		const existing: AnyStoredComment[] = [
			{
				id: "local-1",
				file: "src/main.ts",
				line: 42,
				message: "Fix this.",
				status: "fixed",
				source: "imported",
				importMeta: {
					remoteId: "rc-1",
					remoteAuthor: "reviewer",
					remoteUrl: "https://github.com/org/repo/pull/1#discussion-123",
					importedAt: new Date().toISOString(),
					resolvedOnRemote: false,
				},
			} as ImportedComment,
		];

		const cache = makeCache(existing);
		const provider = makeProvider([testRemoteComment]);
		const importer = new CommentImporter(cache as never);

		const result = await importer.importForPR(provider as never, testPR);

		expect(result.added).toBe(0);
		expect(result.updated).toBe(0);
		expect(cache.comments[0]?.status).toBe("fixed");
		expect(cache.comments).toHaveLength(1);
	});

	test("re-import updates content of still-open imported comments", async () => {
		const existing: AnyStoredComment[] = [
			{
				id: "local-1",
				file: "src/main.ts",
				line: 42,
				message: "Old content.",
				status: "imported",
				source: "imported",
				importMeta: {
					remoteId: "rc-1",
					remoteAuthor: "reviewer",
					remoteUrl: "https://github.com/org/repo/pull/1#discussion-123",
					importedAt: new Date().toISOString(),
					resolvedOnRemote: false,
				},
			} as ImportedComment,
		];

		const cache = makeCache(existing);
		const updatedRemote: RemoteComment = {
			...testRemoteComment,
			content: "Updated content.",
			resolved: true,
		};
		const provider = makeProvider([updatedRemote]);
		const importer = new CommentImporter(cache as never);

		const result = await importer.importForPR(provider as never, testPR);

		expect(result.added).toBe(0);
		expect(result.updated).toBe(1);
		expect(cache.comments[0]?.message).toBe("Updated content.");
		expect((cache.comments[0] as ImportedComment).importMeta.resolvedOnRemote).toBe(true);
		// ID preserved
		expect(cache.comments[0]?.id).toBe("local-1");
	});

	test("file defaults to empty string when filePath absent", async () => {
		const generalComment: RemoteComment = {
			id: "rc-2",
			author: "reviewer",
			content: "General PR comment.",
			url: "https://github.com/org/repo/pull/1#issuecomment-456",
			resolved: false,
		};

		const cache = makeCache();
		const provider = makeProvider([generalComment]);
		const importer = new CommentImporter(cache as never);

		await importer.importForPR(provider as never, testPR);

		expect(cache.comments[0]?.file).toBe("");
	});
});
```

- [ ] **Step 3: Run tests — verify they fail (module not found)**

```bash
bun test tests/comment-importer.test.ts
```

Expected: error — `Cannot find module '../src/review/comment-importer'`.

- [ ] **Step 4: Implement `src/review/comment-importer.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type LocalCache from "../cache/local-cache";
import type { GitProvider, RemoteComment } from "../git-providers/types";
import { getPRKey } from "../git-providers/types";
import type { PullRequest } from "../git-providers/types";
import type {
	AnyStoredComment,
	ImportedComment,
	StoredReviewComment,
} from "./types";

export type ImportResult = {
	fetched: number;
	added: number;
	updated: number;
};

export class CommentImporter {
	constructor(private cache: LocalCache) {}

	async importForPR(
		provider: GitProvider,
		pr: PullRequest,
	): Promise<ImportResult> {
		const prKey = getPRKey(pr);

		const remoteComments = await provider.fetchPullRequestComments(pr);
		const incoming = remoteComments.map((c) =>
			this.normalize(c),
		);

		const existing = (await this.cache.getComments(
			prKey,
		)) as AnyStoredComment[];

		const { merged, added, updated } = this.merge(incoming, existing);

		await this.cache.saveComments(prKey, merged as unknown as StoredReviewComment[]);

		this.cache.setImportedAt(
			{ sourceBranch: pr.source.name, targetBranch: pr.target.name },
			new Date().toISOString(),
		);

		return { fetched: remoteComments.length, added, updated };
	}

	private normalize(remote: RemoteComment): ImportedComment {
		return {
			id: randomUUID(),
			file: remote.filePath ?? "",
			line: remote.line,
			startLine: remote.startLine,
			message: remote.content,
			status: "imported",
			source: "imported",
			importMeta: {
				remoteId: remote.id,
				remoteAuthor: remote.author,
				remoteUrl: remote.url,
				importedAt: new Date().toISOString(),
				resolvedOnRemote: remote.resolved,
			},
		};
	}

	private merge(
		incoming: ImportedComment[],
		existing: AnyStoredComment[],
	): { merged: AnyStoredComment[]; added: number; updated: number } {
		let added = 0;
		let updated = 0;

		const result: AnyStoredComment[] = [...existing];

		for (const comment of incoming) {
			const existingIdx = result.findIndex(
				(e) =>
					e.source === "imported" &&
					e.importMeta?.remoteId === comment.importMeta.remoteId,
			);

			if (existingIdx === -1) {
				result.push(comment);
				added++;
			} else {
				const found = result[existingIdx]!;
				if (found.status === "imported") {
					result[existingIdx] = {
						...found,
						message: comment.message,
						importMeta: {
							...(found as ImportedComment).importMeta,
							resolvedOnRemote: comment.importMeta.resolvedOnRemote,
						},
					} as ImportedComment;
					updated++;
				}
				// status === "fixed" | "rejected" → leave untouched
			}
		}

		return { merged: result, added, updated };
	}
}
```

- [ ] **Step 5: Run tests — verify they pass**

```bash
bun test tests/comment-importer.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 6: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/review/comment-importer.ts tests/comment-importer.test.ts package.json
git commit -m "feat: implement CommentImporter with TDD (normalize, merge, deduplicate)"
```

---

## Task 5: GitHub — fetchPullRequestComments

**Files:**
- Modify: `src/git-providers/github.ts`

- [ ] **Step 1: Add private `GitHubPRComment` type and replace stub**

Add the private type before the `GitHubProvider` class definition:

```typescript
type GitHubPRComment = {
	id: number;
	user: { login: string };
	body: string;
	path: string;
	line: number | null;
	start_line: number | null;
	html_url: string;
	position: number | null; // null when comment is on an outdated diff hunk
};
```

Replace the stub `fetchPullRequestComments` implementation inside `GitHubProvider`:

```typescript
async fetchPullRequestComments(pr: PullRequest): Promise<RemoteComment[]> {
	const token = process.env.GITHUB_TOKEN;
	if (!token) {
		throw new Error("GITHUB_TOKEN is not set");
	}

	const { projectKey: owner, repoSlug: repo } = this.remote;
	const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr.id}/comments?per_page=100`;

	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
		},
	});

	this.handleRateLimit(response);

	if (!response.ok) {
		if (response.status === 401) {
			throw new Error(
				"GitHub authentication failed: GITHUB_TOKEN may be invalid",
			);
		}
		throw new Error(
			`Failed to fetch PR comments: ${response.status} ${response.statusText}`,
		);
	}

	const data = (await response.json()) as GitHubPRComment[];

	return data.map(
		(c): RemoteComment => ({
			id: String(c.id),
			author: c.user.login,
			content: c.body,
			filePath: c.path || undefined,
			line: c.line ?? undefined,
			startLine: c.start_line ?? undefined,
			url: c.html_url,
			// position === null means the comment is on an outdated diff hunk
			resolved: c.position === null,
		}),
	);
}
```

- [ ] **Step 2: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/git-providers/github.ts
git commit -m "feat: implement fetchPullRequestComments for GitHub provider"
```

---

## Task 6: Bitbucket — fetchPullRequestComments

**Files:**
- Modify: `src/git-providers/bitbucket.ts`

- [ ] **Step 1: Add private `BitbucketPRComment` type and replace stub**

Add the private type after the existing `BitbucketCommentResponse` type (around line 52):

```typescript
type BitbucketPRComment = {
	id: number;
	text: string;
	author: { slug: string; displayName?: string };
	anchor?: { path: string; line?: number };
	links: { self: [{ href: string }] };
	threadResolved: boolean;
};
```

Replace the stub `fetchPullRequestComments` implementation inside `BitbucketServerGitProvider`:

```typescript
async fetchPullRequestComments(pr: PullRequest): Promise<RemoteComment[]> {
	if (!BB_TOKEN) {
		throw new Error("BB_TOKEN is not set");
	}

	const allComments: RemoteComment[] = [];
	let start = 0;

	while (true) {
		const url =
			`${this.buildPullRequestsUrl()}/${encodeURIComponent(String(pr.id))}/comments` +
			`?limit=100&start=${start}`;

		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${BB_TOKEN}` },
		});

		if (!response.ok) {
			throw new Error(
				`Failed to fetch PR comments: ${response.status} ${response.statusText}`,
			);
		}

		const data =
			(await response.json()) as BitbucketPagedResponse<BitbucketPRComment>;

		for (const c of data.values) {
			allComments.push({
				id: String(c.id),
				author: c.author.displayName ?? c.author.slug,
				content: c.text,
				filePath: c.anchor?.path,
				line: c.anchor?.line,
				url: c.links.self[0]?.href ?? "",
				resolved: c.threadResolved,
			});
		}

		if (data.isLastPage) {
			break;
		}

		start += data.values.length;
	}

	return allComments;
}
```

- [ ] **Step 2: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/git-providers/bitbucket.ts
git commit -m "feat: implement fetchPullRequestComments for Bitbucket Server provider"
```

---

## Task 7: WorkflowState — importedPendingCount + detectState

**Files:**
- Modify: `src/cli/types.ts`
- Modify: `src/cli/managers/workflow-state-manager.ts`

- [ ] **Step 1: Add `importedPendingCount` to `WorkflowState` in `src/cli/types.ts`**

In the `WorkflowState` interface, add after `rejectedCount`:

```typescript
export interface WorkflowState {
	// Context state
	hasContext: boolean;
	contextUpToDate: boolean;
	contextMeta?: ContextMetadata;

	// Review/Comments state
	hasComments: boolean;
	pendingCount: number;
	acceptedCount: number;
	fixedCount: number;
	rejectedCount: number;

	// Remote comments state
	hasRemoteComments: boolean;
	remoteCommentsCount: number;
	importedPendingCount: number; // imported comments not yet fixed/dismissed

	// PR state
	currentCommit: string;
	hasNewCommits: boolean;
}
```

- [ ] **Step 2: Update `detectState` in `src/cli/managers/workflow-state-manager.ts`**

Replace the comment counting block and return statement (lines 48–80) with:

```typescript
// Check comments state
const comments = await this.cache.getComments(prKey);
const hasComments = comments.length > 0;

const pendingCount = comments.filter(
	(c) => (c.status === "pending" || !c.status) && c.source !== "imported",
).length;
const acceptedCount = comments.filter(
	(c) => c.status === "accepted",
).length;
const fixedCount = comments.filter((c) => c.status === "fixed").length;
const rejectedCount = comments.filter(
	(c) => c.status === "rejected" && c.source !== "imported",
).length;

// Remote comments state
const importedPendingCount = comments.filter(
	(c) => c.source === "imported" && c.status === "imported",
).length;
const remoteCommentsCount = comments.filter(
	(c) => c.source === "imported",
).length;
const hasRemoteComments = cacheMetadata?.importedAt != null;

// Check for new commits since last context/review
const hasNewCommits = contextMeta
	? contextMeta.gatheredFromCommit !== pr.source.commitHash
	: false;

return {
	hasContext,
	contextUpToDate,
	contextMeta,
	hasComments,
	pendingCount,
	acceptedCount,
	fixedCount,
	rejectedCount,
	hasRemoteComments,
	remoteCommentsCount,
	importedPendingCount,
	currentCommit: pr.source.commitHash,
	hasNewCommits,
};
```

- [ ] **Step 3: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/types.ts src/cli/managers/workflow-state-manager.ts
git commit -m "feat: populate hasRemoteComments, remoteCommentsCount, importedPendingCount in workflow state"
```

---

## Task 8: Menu — getAvailableActions + generateMenuOptions

**Files:**
- Modify: `src/cli/managers/workflow-state-manager.ts`

- [ ] **Step 1: Uncomment `handle_remote` in `getAvailableActions`**

Replace the commented-out block (lines ~117–120):

```typescript
// Future: Remote comments
// if (state.hasRemoteComments) {
//   actions.push("handle_remote");
// }
```

With:

```typescript
// Remote comments: always available so user can trigger import or handle open ones
if (!(state.hasRemoteComments && state.importedPendingCount === 0)) {
	actions.push("handle_remote");
}
```

- [ ] **Step 2: Update `handle_remote` case in `generateMenuOptions`**

Replace the existing `case "handle_remote":` block (around lines 204–211):

```typescript
case "handle_remote":
	options.push({
		value: "handle_remote",
		label:
			state.importedPendingCount > 0
				? `💬 Handle ${state.importedPendingCount} Reviewer Comment${state.importedPendingCount !== 1 ? "s" : ""}`
				: "💬 Import Reviewer Comments",
		hint:
			state.importedPendingCount > 0
				? "Address comments from remote reviewers (fix, dismiss, or create memory)"
				: "Fetch and address comments left by remote reviewers",
		recommended:
			state.importedPendingCount > 0 && state.pendingCount === 0,
	});
	break;
```

- [ ] **Step 3: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/managers/workflow-state-manager.ts
git commit -m "feat: enable handle_remote action and update menu label based on import state"
```

---

## Task 9: PRWorkflowManager — getProvider()

**Files:**
- Modify: `src/cli/managers/pr-workflow-manager.ts`

- [ ] **Step 1: Add `getProvider` accessor**

Add after `setProviderForRemote` (around line 32):

```typescript
public getProvider(): GitProvider {
	if (!this.provider) {
		throw new Error(
			"Git provider not set. Call setProviderForRemote first.",
		);
	}
	return this.provider;
}
```

- [ ] **Step 2: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/managers/pr-workflow-manager.ts
git commit -m "feat: expose getProvider() on PRWorkflowManager"
```

---

## Task 10: promptImportedCommentAction

**Files:**
- Modify: `src/cli/cli-prompts.ts`

- [ ] **Step 1: Add `promptImportedCommentAction` function**

Add at the end of `src/cli/cli-prompts.ts`:

```typescript
export async function promptImportedCommentAction(
	hideCreateMemory = false,
): Promise<"fix" | "dismiss" | "skip" | "quit" | "create_memory" | null> {
	const allOptions = [
		{
			value: "fix",
			label: "🔧 Fix with Claude",
			hint: "Plan and implement a code fix for this comment",
		},
		{
			value: "create_memory",
			label: "Create memory",
			hint: "Distil this comment into a reusable memory",
		},
		{
			value: "dismiss",
			label: "✗ Dismiss",
			hint: "Dismiss this comment without changes",
		},
		{
			value: "skip",
			label: "⏭ Skip",
			hint: "Skip for now, address in next session",
		},
		{
			value: "quit",
			label: "💤 Quit",
			hint: "Stop processing and exit",
		},
	];

	const options = hideCreateMemory
		? allOptions.filter((opt) => opt.value !== "create_memory")
		: allOptions;

	const action = await clack.select({
		message: theme.primary("What should we do with this reviewer comment?"),
		options,
	});

	if (clack.isCancel(action)) {
		return null;
	}

	return action as "fix" | "dismiss" | "skip" | "quit" | "create_memory";
}
```

- [ ] **Step 2: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/cli-prompts.ts
git commit -m "feat: add promptImportedCommentAction for reviewer comment handling"
```

---

## Task 11: CommentResolutionManager — handleImportedComments

**Files:**
- Modify: `src/cli/managers/comment-resolution-manager.ts`

- [ ] **Step 1: Add imports**

At the top of `src/cli/managers/comment-resolution-manager.ts`, update the import from `../../review/types`:

```typescript
import type {
	ImportedComment,
	ReviewComment,
	ReviewCommentStatus,
	StoredReviewComment,
} from "../../review/types";
```

Also add `promptImportedCommentAction` to the import from `../cli-prompts`:

```typescript
import {
	promptCommentAction,
	promptImportedCommentAction,
} from "../cli-prompts";
```

- [ ] **Step 2: Add `handleImportedComments` method**

Add this method to the `CommentResolutionManager` class after `handleComments`:

```typescript
/**
 * Execute reviewer comment resolution workflow.
 *
 * Differs from handleComments: no "accept" action (can't post imported comments
 * back to remote). Actions: fix, create_memory, dismiss, skip, quit.
 */
public async handleImportedComments(
	prKey: string,
	importedComments: ImportedComment[],
	onFixRequested: (
		comment: ReviewComment,
		prKey: string,
		summary: {
			accepted: number;
			fixed: number;
			rejected: number;
			skipped: number;
		},
	) => Promise<void>,
	displayCommentFn: (comment: ReviewComment) => Promise<void>,
): Promise<HandleCommentsResult> {
	console.log("");
	this.ui.section("Reviewer Comment Resolution");

	if (importedComments.length === 0) {
		this.ui.success(theme.success("✓ No open reviewer comments"));
		return { processed: 0, fixed: 0, accepted: 0, rejected: 0, skipped: 0 };
	}

	this.ui.info(
		theme.secondary(
			`Found ${importedComments.length} open reviewer comment(s)`,
		),
	);

	const summary = { accepted: 0, fixed: 0, rejected: 0, skipped: 0 };

	for (let i = 0; i < importedComments.length; i++) {
		const comment = importedComments[i];
		if (!comment) continue;

		this.ui.space();
		this.ui.log(
			theme.primary(
				`━━━ Comment ${i + 1} of ${importedComments.length} ━━━`,
			),
		);
		this.ui.info(
			`${theme.secondary("From:")} ${comment.importMeta.remoteAuthor}  ${theme.muted(comment.importMeta.remoteUrl)}`,
		);
		this.ui.space();

		let shouldContinue = true;
		let hideCreateMemory = comment.memoryCreated === true;

		while (shouldContinue) {
			await displayCommentFn(comment);
			this.ui.space();

			const action = await promptImportedCommentAction(hideCreateMemory);

			if (action === null) {
				this.ui.cancel("Comment resolution cancelled");
				shouldContinue = false;
				break;
			}

			switch (action) {
				case "create_memory": {
					const notesResponse = await clack.text({
						message:
							"Any optional context/notes? (Enter to skip, Ctrl+C to cancel)",
						placeholder: 'e.g., "This applies to all async handlers"',
					});

					if (clack.isCancel(notesResponse)) {
						this.ui.logStep(theme.muted("Memory creation cancelled"));
						break;
					}

					const additionalContext =
						typeof notesResponse === "string" &&
						notesResponse.trim().length > 0
							? notesResponse.trim()
							: undefined;

					this.ui.info(theme.accent("Creating memory from comment..."));

					try {
						const result = await this.memoryService.createMemory({
							file: comment.file,
							severity: comment.severity ?? "suggestion",
							code: comment.codeSnippet ?? "",
							comment: comment.message,
							additionalContext,
						});

						await this.cache.updateComment(prKey, comment.id, {
							memoryCreated: true,
						});

						this.ui.success(theme.success("✓ Memory stored"));
						this.ui.info(
							theme.secondary(`Situation: ${result.situation}`),
						);
						this.ui.info(theme.secondary(`Lesson: ${result.lesson}`));
					} catch (error) {
						this.ui.warn(
							theme.warning(
								`⚠️ Failed to create memory: ${error instanceof Error ? error.message : String(error)}`,
							),
						);
					}

					this.ui.space();
					this.ui.info(
						theme.secondary("Now decide what to do with this comment:"),
					);
					this.ui.space();
					hideCreateMemory = true;
					break;
				}

				case "fix": {
					await onFixRequested(comment, prKey, summary);
					shouldContinue = false;
					break;
				}

				case "dismiss": {
					await this.cache.updateComment(prKey, comment.id, {
						status: "rejected",
					});
					summary.rejected++;
					this.ui.logStep(theme.muted("✗ Comment dismissed"));
					shouldContinue = false;
					break;
				}

				case "skip": {
					summary.skipped++;
					this.ui.logStep(theme.muted("⏭ Comment skipped"));
					shouldContinue = false;
					break;
				}

				case "quit": {
					this.ui.info(
						theme.secondary("Exiting reviewer comment resolution..."),
					);

					if (summary.fixed + summary.rejected > 0) {
						console.log("");
						this.displayResolutionSummary(summary);
					}

					this.ui.sectionComplete(
						"Reviewer comment resolution paused",
					);
					return {
						processed: summary.fixed + summary.rejected,
						fixed: summary.fixed,
						accepted: 0,
						rejected: summary.rejected,
						skipped: summary.skipped,
					};
				}
			}
		}
	}

	console.log("");
	this.displayResolutionSummary(summary);
	this.ui.sectionComplete("Reviewer comment resolution complete");

	return {
		processed: summary.fixed + summary.rejected,
		fixed: summary.fixed,
		accepted: 0,
		rejected: summary.rejected,
		skipped: summary.skipped,
	};
}
```

- [ ] **Step 3: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/managers/comment-resolution-manager.ts
git commit -m "feat: add handleImportedComments to CommentResolutionManager"
```

---

## Task 12: ActionExecutor — executeHandleRemote

**Files:**
- Modify: `src/cli/managers/action-executor.ts`

- [ ] **Step 1: Add `CommentImporter` import and constructor parameter**

Update the imports at the top:

```typescript
import type { CommentImporter } from "../../review/comment-importer";
import type { ImportedComment } from "../../review/types";
```

Update the `ActionExecutor` constructor to add `commentImporter` as the last parameter:

```typescript
constructor(
	private prWorkflow: PRWorkflowManager,
	private commentResolution: CommentResolutionManager,
	private fixSession: FixSessionOrchestrator,
	private commentDisplay: CommentDisplayService,
	private contextGathererFactory: ContextGathererFactory,
	private codeReviewer: CodeReviewer,
	private cache: LocalCache,
	private memoryService: MemoryService,
	private memoryQueryGenerator: MemoryQueryGenerator,
	private commentImporter: CommentImporter,
) {}
```

- [ ] **Step 2: Implement `executeHandleRemote`**

Add this method to `ActionExecutor` after `executeSendAccepted`:

```typescript
/**
 * Fetch reviewer comments from remote and enter handling loop.
 *
 * Always re-fetches to pick up new/updated comments, then filters
 * to those still open (status: "imported") for processing.
 */
async executeHandleRemote(pr: PullRequest): Promise<void> {
	const prKey = getPRKey(pr);
	const spinner = ui.spinner();
	spinner.start(theme.accent("Fetching reviewer comments from remote"));

	try {
		const result = await this.commentImporter.importForPR(
			this.prWorkflow.getProvider(),
			pr,
		);
		spinner.stop(
			theme.success(
				`✓ ${result.fetched} comment(s) fetched` +
					(result.added > 0 || result.updated > 0
						? ` (${result.added} new, ${result.updated} updated)`
						: ""),
			),
		);
	} catch (error) {
		spinner.stop(theme.error("✗ Failed to fetch reviewer comments"));
		ui.error(
			theme.muted(`   ${(error as Error).message}`),
		);
		return;
	}

	const allComments = await this.cache.getComments(prKey);
	const importedPending = allComments.filter(
		(c) => c.source === "imported" && c.status === "imported",
	) as ImportedComment[];

	if (importedPending.length === 0) {
		ui.info(theme.muted("No open reviewer comments found."));
		return;
	}

	await this.commentResolution.handleImportedComments(
		prKey,
		importedPending,
		async (comment, prKeyArg, interimSummary) => {
			const optionalNotes =
				await this.commentDisplay.promptOptionalNotes();
			await this.fixSession.runFixSession(
				comment,
				prKeyArg,
				optionalNotes,
				interimSummary,
			);
		},
		async (comment) => {
			await this.commentDisplay.displayCommentWithContext(comment);
		},
	);
}
```

- [ ] **Step 3: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/managers/action-executor.ts
git commit -m "feat: implement executeHandleRemote on ActionExecutor"
```

---

## Task 13: CLIOrchestrator — handle_remote Routing

**Files:**
- Modify: `src/cli/orchestrator.ts`

- [ ] **Step 1: Add `handle_remote` case to `executeAction`**

In the `executeAction` switch statement, add before the `default` case:

```typescript
case "handle_remote":
	await this.actionExecutor.executeHandleRemote(context.pr);
	break;
```

The full switch should now include all of: `gather_context`, `refresh_context`, `run_review`, `review_with_context`, `handle_pending`, `send_accepted`, `handle_remote`, `exit`, `default`.

- [ ] **Step 2: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/orchestrator.ts
git commit -m "feat: route handle_remote action to executeHandleRemote in CLIOrchestrator"
```

---

## Task 14: src/index.ts — Wire Dependencies

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import `CommentImporter`**

Add to the existing import block in `src/index.ts`:

```typescript
import { CommentImporter } from "./review/comment-importer";
```

- [ ] **Step 2: Instantiate `CommentImporter` and wire into `ActionExecutor`**

After the line `const prWorkflow = new PRWorkflowManager(git, gitProviderFactory, ui);` (around line 121), add:

```typescript
const commentImporter = new CommentImporter(cache);
```

Then update the `ActionExecutor` constructor call to add `commentImporter` as the last argument:

```typescript
const actionExecutor = new ActionExecutor(
	prWorkflow,
	commentResolution,
	fixSession,
	commentDisplay,
	contextGathererFactory,
	codeReviewer,
	cache,
	memoryService,
	memoryQueryGenerator,
	commentImporter,
);
```

- [ ] **Step 3: Run linter**

```bash
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 5: Smoke test — start the tool and verify the new menu option appears**

```bash
bun run src/index.ts
```

Select a remote and PR. Verify the menu shows "💬 Import Reviewer Comments" (or "💬 Handle N Reviewer Comments" if previously imported). Select it. Verify comments are fetched and the handling loop starts.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire CommentImporter into ActionExecutor in dependency injection root"
```
