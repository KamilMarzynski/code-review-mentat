# Comment Posting — Design Spec

**Date:** 2026-04-01
**Branch:** feat/github-provider
**Status:** Approved

---

## Summary

Complete the comment-posting pipeline so that accepted review comments can be posted to the remote PR (Bitbucket Server or GitHub), tracked with a `'posted'` status, and shown with a URL after posting. Failed posts leave comments as `'accepted'` so the existing "Send accepted" menu option acts as a natural retry.

Most infrastructure already exists. This spec covers the gaps: new statuses/fields, URL extraction from providers, confidence formatting, and wiring status updates through the executor layer.

---

## 1. Type Changes

### `src/review/types.ts`

Add `'posted'` to `ReviewCommentStatus`:

```ts
export type ReviewCommentStatus =
  | 'pending'
  | 'fixed'
  | 'accepted'
  | 'rejected'
  | 'posted';
```

Add remote-tracking fields to `StoredReviewComment`:

```ts
export type StoredReviewComment = ReviewComment & {
  id: string;
  codeSnippet?: string;
  remoteCommentId?: number;   // Provider-assigned ID after posting
  remoteCommentUrl?: string;  // Permalink to comment on remote
};
```

### `src/git-providers/types.ts`

Add `url` to `CreatedPrComment`:

```ts
export type CreatedPrComment = {
  id: number;
  url?: string;
};
```

Add `confidence` to `CreatePullRequestCommentRequest` so providers can include it in formatted text:

```ts
export type CreatePullRequestCommentRequest = {
  text: string;
  parentId?: number;
  path?: string;
  line?: number;
  severity?: 'nit' | 'suggestion' | 'issue' | 'risk';
  confidence?: 'high' | 'medium' | 'low';  // NEW
};
```

---

## 2. Provider Changes

### `src/git-providers/bitbucket.ts`

- Remove debug `console.log` statements (lines 162–165 and 177).
- Extend `BitbucketCommentResponse` to capture the link:
  ```ts
  type BitbucketCommentResponse = {
    id: number;
    links: { self: [{ href: string }] };
  };
  ```
- Return `url` from `createPullRequestComment`:
  ```ts
  return { id: data.id, url: data.links.self[0]?.href };
  ```
- No change to severity mapping (BLOCKER/NORMAL) or anchor logic.
- `confidence` field is ignored by Bitbucket (severity already covers criticality).

### `src/git-providers/github.ts`

- Extend `GitHubReviewResponse` to capture `html_url`:
  ```ts
  type GitHubReviewResponse = { id: number; html_url: string };
  ```
- Build comment body including both severity and confidence prefixes:
  ```ts
  const prefix = [
    comment.severity   ? `[${comment.severity}]`             : null,
    comment.confidence ? `[${comment.confidence} confidence]` : null,
  ].filter(Boolean).join(' ');

  const body = prefix ? `${prefix} ${comment.text}` : comment.text;
  ```
- Return `url` from `createPullRequestComment`:
  ```ts
  return { id: data.id, url: data.html_url };
  ```

---

## 3. `PRWorkflowManager` — `postCommentsToRemote`

### New return type (add to `src/cli/managers/pr-workflow-manager.ts`)

```ts
export type PostCommentResult = {
  comment: ReviewComment;
  success: boolean;
  id?: number;
  url?: string;
  error?: string;
};
```

### Signature change

```ts
async postCommentsToRemote(
  pr: PullRequest,
  comments: ReviewComment[],
): Promise<PostCommentResult[]>
```

### Behavior

- Per-comment try/catch is preserved (partial failures do not abort the loop).
- On success: push `{ comment, success: true, id, url }`.
- On failure: push `{ comment, success: false, error: message }`.
- **No UI calls** inside `postCommentsToRemote` — callers own all display.
- Thread `confidence` from the `ReviewComment` into the `CreatePullRequestCommentRequest`.

### Comment text format (built in `postCommentsToRemote`)

```
_[severity]_ message.
**Rationale**: rationale

_Comment created by Mentat Code Review CLI._
```

Confidence is passed separately to the provider via `CreatePullRequestCommentRequest.confidence`; the GitHub provider formats it into the body. Bitbucket ignores it.

---

## 4. `ActionExecutor` — `executeSendAccepted`

After receiving `PostCommentResult[]`:

1. For each **successful** result:
   - Call `cache.updateComment(prKey, comment.id, { status: 'posted', remoteCommentId: id, remoteCommentUrl: url })`.
   - Display: `✓ Posted to <url>` (or `✓ Posted to <path>:<line>` if no URL).

2. For each **failed** result:
   - Display: `✗ Failed: <path>:<line> — <error>` (already logged by `postCommentsToRemote`).
   - Comment remains `'accepted'` — "Send accepted" menu option reappears as natural retry.

3. Return count of successful posts.

---

## 5. Out of Scope

- Batching GitHub comments into a single review (current per-comment review approach is retained).
- Fetching/displaying existing remote comments.
- Explicit `'failed_to_post'` status or a dedicated retry menu action.
- Comment deduplication (don't re-post already-`'posted'` comments).

### Note on deduplication

`executeSendAccepted` already filters for `status === 'accepted'`. Once a comment is marked `'posted'`, it will not be selected again. This is the natural deduplication mechanism.

---

## Files Changed

| File | Change |
|------|--------|
| `src/review/types.ts` | Add `'posted'` status; add `remoteCommentId`, `remoteCommentUrl` to `StoredReviewComment` |
| `src/git-providers/types.ts` | Add `url` to `CreatedPrComment`; add `confidence` to `CreatePullRequestCommentRequest` |
| `src/git-providers/bitbucket.ts` | Extract URL from response; remove console.log |
| `src/git-providers/github.ts` | Extract `html_url`; format confidence in body |
| `src/cli/managers/pr-workflow-manager.ts` | Return `PostCommentResult[]`; thread confidence |
| `src/cli/managers/action-executor.ts` | Update cache status; display URLs; fix `promptAndSendAccepted` (legacy) to handle new return type |
