# Import Remote Comments — Design Spec

**Date:** 2026-04-03
**Branch:** feat/import-remote-comments
**Status:** Approved

---

## Overview

Allow the tool to fetch existing reviewer comments from a remote Git provider (GitHub, Bitbucket) and surface them in the CLI workflow. The user can then fix code, dismiss, or create memory entries for each imported comment — without having to run an AI review first.

This feature is purely additive. Existing agent-generated comment flow is untouched.

---

## Scope

**In scope:**
- GitHub and Bitbucket Server providers
- Menu-driven import (not automatic)
- Handle imported comments: fix, dismiss, create memory
- Deduplication on re-import

**Out of scope:**
- GitLab
- Automatic background fetch
- Posting replies back to remote (future)
- Bi-directional sync (future)

---

## Type System

### Status union

Add `"imported"` as the initial lifecycle state for remote-sourced comments:

```typescript
type ReviewCommentStatus =
  | "pending"   // agent comment, unprocessed
  | "fixed"     // code was changed to address comment
  | "accepted"  // agent comment accepted as-is, ready to post
  | "rejected"  // dismissed / not applicable
  | "posted"    // agent comment posted to remote
  | "imported"  // fetched from remote, unprocessed
```

### Import metadata

Nested type to group inbound remote fields — kept separate from existing `remoteCommentId`/`remoteCommentUrl` which track outbound posting:

```typescript
type ImportMetadata = {
  remoteId: string          // provider's comment ID
  remoteAuthor: string      // reviewer's username
  remoteUrl: string         // permalink to original comment
  importedAt: string        // ISO timestamp of fetch
  resolvedOnRemote: boolean // whether remote comment is already marked resolved
}
```

### Discriminated union

Replaces bare `StoredReviewComment[]` at callsites that need to distinguish origin. Makes invalid states (e.g. `source: "imported"` with `status: "pending"`) unrepresentable:

```typescript
type GeneratedComment = StoredReviewComment & {
  source: "generated"
  status: "pending" | "accepted" | "fixed" | "rejected" | "posted"
  importMeta?: never
}

type ImportedComment = StoredReviewComment & {
  source: "imported"
  status: "imported" | "fixed" | "rejected"
  importMeta: ImportMetadata
}

export type AnyStoredComment = GeneratedComment | ImportedComment
```

Existing `StoredReviewComment` gains `source?: "generated" | "imported"` and `importMeta?: ImportMetadata` as optional base fields. The discriminated union is the canonical type used in business logic.

---

## Provider Layer

### New abstract method

Added to `GitProvider` abstract class in `src/git-providers/types.ts`:

```typescript
abstract fetchPullRequestComments(pr: PullRequest): Promise<RemoteComment[]>
```

### New `RemoteComment` type

Provider-normalized shape before conversion to `ImportedComment`. Lives in `src/git-providers/types.ts`:

```typescript
export interface RemoteComment {
  id: string
  author: string
  content: string
  filePath?: string
  line?: number
  startLine?: number
  url: string
  resolved: boolean
}
```

### Provider implementations

- **GitHub** (`src/git-providers/github.ts`): `GET /repos/{owner}/{repo}/pulls/{pr_id}/comments`
- **Bitbucket Server** (`src/git-providers/bitbucket.ts`): `GET /rest/api/1.0/projects/{key}/repos/{slug}/pull-requests/{id}/comments`

Both follow the existing auth pattern (token from env var, `handleRateLimit` on response).

---

## CommentImporter

New module: `src/review/comment-importer.ts`

Single responsibility: fetch, normalize, deduplicate, and merge remote comments into the cache.

```typescript
export class CommentImporter {
  constructor(private cache: LocalCache) {}

  async importForPR(
    provider: GitProvider,
    pr: PullRequest,
  ): Promise<{ fetched: number; added: number; updated: number }>

  private normalize(remote: RemoteComment, providerName: string): ImportedComment

  private merge(
    incoming: ImportedComment[],
    existing: AnyStoredComment[],
  ): AnyStoredComment[]
}
```

### Deduplication rules

Match incoming against existing on `importMeta.remoteId`:

| Existing state | Action |
|---|---|
| Not found | Add with `status: "imported"` |
| Found, `status: "imported"` | Update `content` and `resolvedOnRemote` |
| Found, `status: "fixed"` or `"rejected"` | Leave untouched (already processed) |

Merge result is written back via existing `cache.saveComments()`. No new cache methods required.

---

## Cache

One addition to `CachedContext.meta`:

```typescript
meta: {
  // ... existing fields unchanged
  importedAt?: string  // ISO timestamp of last successful import
}
```

Used by `WorkflowStateManager` to determine whether to offer a refresh. All comment storage/retrieval uses existing `saveComments`/`getComments`/`updateComment` — imported comments are stored in the same `comments[]` array, distinguished by `source`.

---

## Workflow Integration

### WorkflowState

The two stub fields already exist and are now populated. One new field added:

```typescript
hasRemoteComments: boolean      // true when importedAt is set in cache meta
remoteCommentsCount: number     // total imported comments
importedPendingCount: number    // NEW — imported comments still at status: "imported"
```

`WorkflowStateManager.detectState` filters cached comments by `source: "imported"` to compute these.

### WorkflowAction

`"handle_remote"` already exists in the union — no change needed.

### Menu options

| State | Option shown |
|---|---|
| `importedAt` absent | "Import reviewer comments" |
| `importedPendingCount > 0` | "Handle reviewer comments (N open)" ⭐ |
| All imported resolved | Not shown |

### ActionExecutor

New method `executeHandleRemote(pr: PullRequest)`:

1. Check `importedAt` in cache — if absent or stale, run `CommentImporter.importForPR` with spinner
2. Filter cached comments to `status: "imported"`
3. If none → show "No open reviewer comments"
4. Display each with author, remote URL, file:line
5. Per-comment action loop:
   - **Fix** → reuses `FixSessionOrchestrator` (plan + execute)
   - **Dismiss** → sets `status: "rejected"`
   - **Create memory** → extracts insight into memory system
   - **Skip** → leaves `status: "imported"` for later

---

## What Is Not Changing

- Agent review flow (`run_review`, `handle_pending`, `send_accepted`) — unchanged
- Agent does not receive imported comments as input during review (avoids bias)
- `remoteCommentId` and `remoteCommentUrl` on `StoredReviewComment` — these track outbound posting and are not reused for imported data
- `FixIteration` type — unchanged
- `LocalCache` public API — unchanged except for `importedAt` in meta

---

## Files Changed

| File | Change |
|---|---|
| `src/review/types.ts` | Add `"imported"` to status union; add `source`, `importMeta` fields; export `AnyStoredComment` |
| `src/git-providers/types.ts` | Add `RemoteComment` interface; add abstract `fetchPullRequestComments` |
| `src/git-providers/github.ts` | Implement `fetchPullRequestComments` |
| `src/git-providers/bitbucket.ts` | Implement `fetchPullRequestComments` |
| `src/review/comment-importer.ts` | New file |
| `src/cache/local-cache.ts` | Add `importedAt` to `CachedContext.meta` |
| `src/cli/types.ts` | Add `importedPendingCount` to `WorkflowState` |
| `src/cli/managers/workflow-state-manager.ts` | Populate `hasRemoteComments`, `remoteCommentsCount`, `importedPendingCount` |
| `src/cli/managers/workflow-state-manager.ts` | Generate `handle_remote` menu option |
| `src/cli/managers/action-executor.ts` | Implement `executeHandleRemote` |
| `src/cli/managers/comment-resolution-manager.ts` | Add imported comment action set (fix, dismiss, create memory, skip) |
