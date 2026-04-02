# Comment Posting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the comment-posting pipeline so accepted review comments are posted to the remote PR, tracked with a `'posted'` status, and shown with a URL after posting.

**Architecture:** Type changes ripple bottom-up — shared types first, then providers, then the manager layer, then the executor layer. Each task is self-contained: types compile, providers pass their own tests, manager and executor follow. `postCommentsToRemote` returns per-comment results instead of void; `executeSendAccepted` processes those results and writes `status: 'posted'` back to the local cache.

**Tech Stack:** TypeScript (strict), Bun runtime, `bun:test` for tests, `fetch` built-in for HTTP.

---

## File Map

| File | Change |
|------|--------|
| `src/review/types.ts` | Add `'posted'` to `ReviewCommentStatus`; add `remoteCommentId?`, `remoteCommentUrl?` to `StoredReviewComment` |
| `src/git-providers/types.ts` | Add `url?` to `CreatedPrComment`; add `confidence?` to `CreatePullRequestCommentRequest` |
| `src/git-providers/bitbucket.ts` | Extend `BitbucketCommentResponse` with `links`; extract URL; remove debug `console.log`s |
| `src/git-providers/github.ts` | Extend `GitHubReviewResponse` with `html_url`; format `[severity] [confidence confidence]` prefix; return URL |
| `src/git-providers/__tests__/github.test.ts` | Add `html_url` to mock responses; update result assertions; add confidence test |
| `src/cli/managers/pr-workflow-manager.ts` | Add `PostCommentResult` type; change `postCommentsToRemote` to return `Promise<PostCommentResult[]>`; use clean text (no severity prefix); thread `confidence` |
| `src/cli/managers/action-executor.ts` | `executeSendAccepted`: process results, update cache, display URLs. Simplify `promptAndSendAccepted` |
| `src/cli/managers/__tests__/action-executor.test.ts` | Add `updateComment` to cache mock; update `executeSendAccepted` tests for new return type |

---

## Task 1: Update shared types

**Files:**
- Modify: `src/review/types.ts`
- Modify: `src/git-providers/types.ts`

- [ ] **Step 1: Add `'posted'` to `ReviewCommentStatus` in `src/review/types.ts`**

  Replace the existing union:
  ```ts
  export type ReviewCommentStatus =
    | "pending" // Not yet addressed
    | "fixed" // Fixed and accepted
    | "accepted" // Accepted as-is
    | "rejected"; // Rejected
  ```
  With:
  ```ts
  export type ReviewCommentStatus =
    | "pending" // Not yet addressed
    | "fixed" // Fixed and accepted
    | "accepted" // Accepted as-is
    | "rejected" // Rejected
    | "posted"; // Posted to remote PR
  ```

- [ ] **Step 2: Add remote-tracking fields to `StoredReviewComment` in `src/review/types.ts`**

  Replace the existing type:
  ```ts
  export type StoredReviewComment = ReviewComment & {
    id: string;
    codeSnippet?: string; // Code snippet related to the comment
  };
  ```
  With:
  ```ts
  export type StoredReviewComment = ReviewComment & {
    id: string;
    codeSnippet?: string; // Code snippet related to the comment
    remoteCommentId?: number; // Provider-assigned ID after posting
    remoteCommentUrl?: string; // Permalink to comment on remote
  };
  ```

- [ ] **Step 3: Add `url?` to `CreatedPrComment` in `src/git-providers/types.ts`**

  Replace:
  ```ts
  export type CreatedPrComment = {
    id: number;
  };
  ```
  With:
  ```ts
  export type CreatedPrComment = {
    id: number;
    url?: string;
  };
  ```

- [ ] **Step 4: Add `confidence?` to `CreatePullRequestCommentRequest` in `src/git-providers/types.ts`**

  Replace:
  ```ts
  export type CreatePullRequestCommentRequest = {
    text: string;

    // Reply to an existing comment
    parentId?: number;

    // Required for any anchored comment
    path?: string;

    // Line comment fields (optional; if present, it's a line anchor)
    line?: number;

    severity?: "nit" | "suggestion" | "issue" | "risk";
  };
  ```
  With:
  ```ts
  export type CreatePullRequestCommentRequest = {
    text: string;

    // Reply to an existing comment
    parentId?: number;

    // Required for any anchored comment
    path?: string;

    // Line comment fields (optional; if present, it's a line anchor)
    line?: number;

    severity?: "nit" | "suggestion" | "issue" | "risk";
    confidence?: "high" | "medium" | "low";
  };
  ```

- [ ] **Step 5: Verify TypeScript compiles**

  Run: `bun tsc --noEmit`
  Expected: no errors (new fields are optional, nothing breaks existing call sites)

- [ ] **Step 6: Commit**

  ```bash
  git add src/review/types.ts src/git-providers/types.ts
  git commit -m "feat: add posted status and remote tracking fields to comment types"
  ```

---

## Task 2: Update Bitbucket provider

**Files:**
- Modify: `src/git-providers/bitbucket.ts`

No dedicated Bitbucket test file exists for `createPullRequestComment`. The provider changes are straightforward: extend the response type, remove debug logs, return the URL.

- [ ] **Step 1: Extend `BitbucketCommentResponse` to capture the self-link**

  Replace:
  ```ts
  type BitbucketCommentResponse = {
    id: number;
  };
  ```
  With:
  ```ts
  type BitbucketCommentResponse = {
    id: number;
    links: { self: [{ href: string }] };
  };
  ```

- [ ] **Step 2: Remove the debug `console.log` of the request body**

  Find and remove these lines (they appear just before the `fetch` call in `createPullRequestComment`):
  ```ts
  console.log(
    "Bitbucket Server PR comment body:",
    JSON.stringify(body, null, 2),
  );
  ```

- [ ] **Step 3: Remove the debug `console.log` of the error response**

  In the `if (!response.ok)` block, replace:
  ```ts
  if (!response.ok) {
    console.log("Bitbucket Server response:", await response.text());
    throw new Error(
      `Failed to create comment: ${response.status} ${response.statusText}`,
    );
  }
  ```
  With:
  ```ts
  if (!response.ok) {
    throw new Error(
      `Failed to create comment: ${response.status} ${response.statusText}`,
    );
  }
  ```

- [ ] **Step 4: Return `url` from the response**

  Replace:
  ```ts
  const data = (await response.json()) as BitbucketCommentResponse;

  return {
    id: data.id,
  };
  ```
  With:
  ```ts
  const data = (await response.json()) as BitbucketCommentResponse;

  return {
    id: data.id,
    url: data.links.self[0]?.href,
  };
  ```

- [ ] **Step 5: Verify TypeScript compiles**

  Run: `bun tsc --noEmit`
  Expected: no errors

- [ ] **Step 6: Commit**

  ```bash
  git add src/git-providers/bitbucket.ts
  git commit -m "feat: extract URL from Bitbucket comment response, remove debug logs"
  ```

---

## Task 3: Update GitHub provider and its tests

**Files:**
- Modify: `src/git-providers/github.ts`
- Modify: `src/git-providers/__tests__/github.test.ts`

The provider changes: extend the review response type, update the body formatter to include confidence, return the URL.

The test changes: add `html_url` to mock responses; update result assertions; add one new test for confidence formatting.

- [ ] **Step 1: Write a failing test for confidence formatting and URL return**

  In `src/git-providers/__tests__/github.test.ts`, inside the `describe("GitHubProvider.createPullRequestComment")` block, add after the existing tests:

  ```ts
  it("includes confidence prefix when both severity and confidence are set", async () => {
    let capturedBody = "";
    global.fetch = mock((_url: string, options?: RequestInit) => {
      capturedBody = options?.body as string;
      return Promise.resolve(
        mockResponse(200, {
          id: 99,
          html_url:
            "https://github.com/acme-org/my-repo/pull/42#pullrequestreview-99",
        }),
      );
    }) as typeof fetch;

    await provider.createPullRequestComment(pr, {
      text: "This looks risky",
      path: "src/auth.ts",
      line: 42,
      severity: "risk",
      confidence: "high",
    });

    const body = JSON.parse(capturedBody);
    expect(body.comments[0].body).toBe(
      "[risk] [high confidence] This looks risky",
    );
  });

  it("returns url from html_url in review response", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        mockResponse(200, {
          id: 99,
          html_url:
            "https://github.com/acme-org/my-repo/pull/42#pullrequestreview-99",
        }),
      ),
    ) as typeof fetch;

    const result = await provider.createPullRequestComment(pr, {
      text: "test",
    });

    expect(result).toEqual({
      id: 99,
      url: "https://github.com/acme-org/my-repo/pull/42#pullrequestreview-99",
    });
  });
  ```

- [ ] **Step 2: Run the new tests to verify they fail**

  Run: `bun test src/git-providers/__tests__/github.test.ts --grep "confidence\|returns url"`
  Expected: FAIL — `url` is undefined (not yet returned), confidence prefix not implemented

- [ ] **Step 3: Update `GitHubReviewResponse` type in `src/git-providers/github.ts`**

  Replace:
  ```ts
  type GitHubReviewResponse = {
    id: number;
  };
  ```
  With:
  ```ts
  type GitHubReviewResponse = {
    id: number;
    html_url: string;
  };
  ```

- [ ] **Step 4: Update `createPullRequestComment` body formatting**

  Replace the existing body-building block in `createPullRequestComment`:
  ```ts
  const body = comment.severity
    ? `[${comment.severity}] ${comment.text}`
    : comment.text;
  ```
  With:
  ```ts
  const prefix = [
    comment.severity ? `[${comment.severity}]` : null,
    comment.confidence ? `[${comment.confidence} confidence]` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const body = prefix ? `${prefix} ${comment.text}` : comment.text;
  ```

- [ ] **Step 5: Return `url` from `createPullRequestComment`**

  Replace:
  ```ts
  const data = (await response.json()) as GitHubReviewResponse;
  return { id: data.id };
  ```
  With:
  ```ts
  const data = (await response.json()) as GitHubReviewResponse;
  return { id: data.id, url: data.html_url };
  ```

- [ ] **Step 6: Run the new tests to verify they pass**

  Run: `bun test src/git-providers/__tests__/github.test.ts --grep "confidence\|returns url"`
  Expected: PASS

- [ ] **Step 7: Update existing tests that assert `result` shape**

  The following tests assert `expect(result).toEqual({ id: N })` but after Step 5 the result includes `url`. Update each by adding `html_url` to the mock response and `url` to the assertion.

  **Test: "posts a line comment with severity prefix"** — update mock response and assertion:
  ```ts
  // mock response (was: mockResponse(200, { id: 99 }))
  return Promise.resolve(
    mockResponse(200, {
      id: 99,
      html_url:
        "https://github.com/acme-org/my-repo/pull/42#pullrequestreview-99",
    }),
  );

  // assertion (was: expect(result).toEqual({ id: 99 }))
  expect(result).toEqual({
    id: 99,
    url: "https://github.com/acme-org/my-repo/pull/42#pullrequestreview-99",
  });
  ```

  **Tests: "posts a general comment"**, **"omits severity prefix"**, **"silently ignores parentId"**, **"defaults line to 1"**, **"calls the correct GitHub API URL"** — these do not assert `result` shape, but their mock responses return `{ id: N }` without `html_url`. For tests that don't check `result.url`, the missing `html_url` results in `url: undefined` which is fine (url is optional in `CreatedPrComment`). No changes needed for those.

  For the "calls the correct GitHub API URL" test, the mock returns `{ id: 1 }` — no assertion on result, no change needed.

- [ ] **Step 8: Run all GitHub provider tests to verify they pass**

  Run: `bun test src/git-providers/__tests__/github.test.ts`
  Expected: all tests PASS

- [ ] **Step 9: Commit**

  ```bash
  git add src/git-providers/github.ts src/git-providers/__tests__/github.test.ts
  git commit -m "feat: return URL from GitHub provider, add confidence prefix formatting"
  ```

---

## Task 4: Update `PRWorkflowManager.postCommentsToRemote`

**Files:**
- Modify: `src/cli/managers/pr-workflow-manager.ts`

Add `PostCommentResult` exported type. Change `postCommentsToRemote` to return `Promise<PostCommentResult[]>`. Build clean comment text (no severity prefix — the provider handles formatting). Thread `confidence`. Remove all UI calls from inside the method.

- [ ] **Step 1: Add the `PostCommentResult` type to `src/cli/managers/pr-workflow-manager.ts`**

  Add this export after the imports, before the class declaration:
  ```ts
  export type PostCommentResult = {
    comment: StoredReviewComment;
    success: boolean;
    id?: number;
    url?: string;
    error?: string;
  };
  ```

  Also add `StoredReviewComment` to the import from `../../review/types`:
  ```ts
  import type { ReviewComment, StoredReviewComment } from "../../review/types";
  ```
  (The existing import only has `ReviewComment`.)

- [ ] **Step 2: Replace `postCommentsToRemote` with the new implementation**

  Replace the entire existing `postCommentsToRemote` method:
  ```ts
  public async postCommentsToRemote(
    pr: PullRequest,
    comments: ReviewComment[],
  ): Promise<void> {
    if (!this.provider) {
      throw new Error("Git provider not set. Call setProviderForRemote first.");
    }
    if (comments.length === 0) {
      this.ui.info(theme.muted("No comments to post to remote."));
      return;
    }

    const prComments: CreatePullRequestCommentRequest[] = comments.map(
      (comment) => ({
        text: `${comment.severity ? `_[${comment.severity}]_ ` : ""}${comment.message}. \n **Rationale**: ${comment.rationale} \n \n _Comment created by Mentat Code Review CLI._`,
        path: comment.file,
        line: comment.line,
        severity: comment.severity,
      }),
    );

    for (const prComment of prComments) {
      try {
        await this.provider.createPullRequestComment(pr, prComment);
        this.ui.success(
          theme.success(
            `✓ Posted comment to ${prComment.path ? `${prComment.path}:${prComment.line}` : "PR discussion"}`,
          ),
        );
      } catch (error) {
        console.log(JSON.stringify(error, null, 2));
        this.ui.error(
          theme.error(
            `✗ Failed to post comment to ${prComment.path ? `${prComment.path}:${prComment.line}` : "PR discussion"}: ${(error as Error).message}`,
          ),
        );
      }
    }
  }
  ```
  With:
  ```ts
  public async postCommentsToRemote(
    pr: PullRequest,
    comments: StoredReviewComment[],
  ): Promise<PostCommentResult[]> {
    if (!this.provider) {
      throw new Error("Git provider not set. Call setProviderForRemote first.");
    }

    const results: PostCommentResult[] = [];

    for (const comment of comments) {
      const prComment: CreatePullRequestCommentRequest = {
        text: `${comment.message}${comment.rationale ? `.\n\n**Rationale**: ${comment.rationale}` : ""}\n\n_Comment created by Mentat Code Review CLI._`,
        path: comment.file,
        line: comment.line,
        severity: comment.severity,
        confidence: comment.confidence,
      };

      try {
        const created = await this.provider.createPullRequestComment(
          pr,
          prComment,
        );
        results.push({
          comment,
          success: true,
          id: created.id,
          url: created.url,
        });
      } catch (error) {
        results.push({
          comment,
          success: false,
          error: (error as Error).message,
        });
      }
    }

    return results;
  }
  ```

- [ ] **Step 3: Verify TypeScript compiles**

  Run: `bun tsc --noEmit`
  Expected: no errors

- [ ] **Step 4: Run all tests to check for regressions**

  Run: `bun test`
  Expected: the existing `action-executor.test.ts` tests for `executeSendAccepted` may fail since the mock for `postCommentsToRemote` currently returns `void`. That's expected — Task 5 fixes the test. All other tests should pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/cli/managers/pr-workflow-manager.ts
  git commit -m "feat: postCommentsToRemote returns PostCommentResult[], removes UI calls"
  ```

---

## Task 5: Update `ActionExecutor` and its tests

**Files:**
- Modify: `src/cli/managers/action-executor.ts`
- Modify: `src/cli/managers/__tests__/action-executor.test.ts`

`executeSendAccepted` processes `PostCommentResult[]`: marks successful posts as `'posted'` in the cache and displays a URL (or file:line fallback). Failed posts are reported but comments stay `'accepted'` for natural retry. `promptAndSendAccepted` is simplified to delegate to `executeSendAccepted`.

- [ ] **Step 1: Write failing tests for the new `executeSendAccepted` behavior**

  Open `src/cli/managers/__tests__/action-executor.test.ts`.

  First, add the import for `PostCommentResult` at the top of the file with the other imports:
  ```ts
  import type { PostCommentResult } from "../pr-workflow-manager";
  ```

  In `beforeEach`, add `updateComment` to the `mockCache` object:
  ```ts
  mockCache = {
    get: mock(() => undefined),
    getComments: mock(async () => []),
    getMemories: mock(() => null),
    set: mock(() => {}),
    saveMemories: mock(() => true),
    setCacheMock: mock(() => {}),
    updateComment: mock(async () => {}),  // ADD THIS
  } as unknown as LocalCache;
  ```

  Also update the `mockPRWorkflow` in `beforeEach` so `postCommentsToRemote` returns `[]` by default (instead of void):
  ```ts
  mockPRWorkflow = {
    fetchCommitHistory: mock(async () => ["commit 1", "commit 2"]),
    analyzeChanges: mock(async () => ({
      fullDiff: "diff content",
      editedFiles: ["file1.ts", "file2.ts"],
    })),
    postCommentsToRemote: mock(async () => [] as PostCommentResult[]),  // changed
  } as unknown as PRWorkflowManager;
  ```

  Replace the entire `describe("executeSendAccepted")` block with:
  ```ts
  describe("executeSendAccepted", () => {
    it("marks successful posts as posted and returns success count", async () => {
      const acceptedComments: StoredReviewComment[] = [
        { id: "1", file: "test.ts", message: "Test", status: "accepted" },
        { id: "2", file: "other.ts", message: "Test 2", status: "accepted" },
      ];

      mockCache.getComments = mock(async () => acceptedComments);

      mockPRWorkflow.postCommentsToRemote = mock(
        async (): Promise<PostCommentResult[]> => [
          {
            comment: acceptedComments[0] as StoredReviewComment,
            success: true,
            id: 100,
            url: "https://example.com/pr/42#comment-100",
          },
          {
            comment: acceptedComments[1] as StoredReviewComment,
            success: true,
            id: 101,
            url: "https://example.com/pr/42#comment-101",
          },
        ],
      );

      const count = await actionExecutor.executeSendAccepted(samplePR);

      expect(count).toBe(2);
      expect(mockPRWorkflow.postCommentsToRemote).toHaveBeenCalled();
      expect(mockCache.updateComment).toHaveBeenCalledTimes(2);
      expect(mockCache.updateComment).toHaveBeenCalledWith(
        "feature-branch|main",
        "1",
        {
          status: "posted",
          remoteCommentId: 100,
          remoteCommentUrl: "https://example.com/pr/42#comment-100",
        },
      );
    });

    it("returns partial count when some posts fail, failed comments stay accepted", async () => {
      const acceptedComments: StoredReviewComment[] = [
        { id: "1", file: "test.ts", message: "Test", status: "accepted" },
        { id: "2", file: "test.ts", message: "Test 2", status: "accepted" },
      ];

      mockCache.getComments = mock(async () => acceptedComments);

      mockPRWorkflow.postCommentsToRemote = mock(
        async (): Promise<PostCommentResult[]> => [
          {
            comment: acceptedComments[0] as StoredReviewComment,
            success: true,
            id: 100,
          },
          {
            comment: acceptedComments[1] as StoredReviewComment,
            success: false,
            error: "Network error",
          },
        ],
      );

      const count = await actionExecutor.executeSendAccepted(samplePR);

      expect(count).toBe(1);
      expect(mockCache.updateComment).toHaveBeenCalledTimes(1);
    });

    it("returns 0 when no accepted comments exist", async () => {
      mockCache.getComments = mock(
        async () =>
          [
            {
              id: "1",
              file: "test.ts",
              message: "Test",
              status: "pending",
            },
          ] satisfies StoredReviewComment[],
      );

      const count = await actionExecutor.executeSendAccepted(samplePR);

      expect(count).toBe(0);
      expect(mockPRWorkflow.postCommentsToRemote).not.toHaveBeenCalled();
    });

    it("handles postCommentsToRemote throwing gracefully", async () => {
      mockCache.getComments = mock(
        async () =>
          [
            {
              id: "1",
              file: "test.ts",
              message: "Test",
              status: "accepted",
            },
          ] satisfies StoredReviewComment[],
      );

      mockPRWorkflow.postCommentsToRemote = mock(async () => {
        throw new Error("Network error");
      });

      const count = await actionExecutor.executeSendAccepted(samplePR);

      expect(count).toBe(0);
    });
  });
  ```

- [ ] **Step 2: Run the new tests to verify they fail**

  Run: `bun test src/cli/managers/__tests__/action-executor.test.ts --grep "executeSendAccepted"`
  Expected: FAIL — `executeSendAccepted` doesn't process `PostCommentResult[]` yet, `updateComment` never called

- [ ] **Step 3: Update `executeSendAccepted` in `src/cli/managers/action-executor.ts`**

  First, add the `PostCommentResult` import:
  ```ts
  import type { PostCommentResult, PRWorkflowManager } from "./pr-workflow-manager";
  ```
  (The existing import only has `type { PRWorkflowManager }` — add `PostCommentResult` to it.)

  Replace the entire `executeSendAccepted` method:
  ```ts
  async executeSendAccepted(pr: PullRequest): Promise<number> {
    const prKey = getPRKey(pr);

    try {
      const comments = await this.cache.getComments(prKey);
      const acceptedComments = comments.filter((c) => c.status === "accepted");

      if (acceptedComments.length === 0) {
        ui.info(theme.muted("No accepted comments to send."));
        return 0;
      }

      const results = await this.prWorkflow.postCommentsToRemote(
        pr,
        acceptedComments,
      );

      let successCount = 0;

      for (const result of results) {
        const location = result.comment.file
          ? `${result.comment.file}${result.comment.line ? `:${result.comment.line}` : ""}`
          : "PR discussion";

        if (result.success) {
          await this.cache.updateComment(prKey, result.comment.id, {
            status: "posted",
            remoteCommentId: result.id,
            remoteCommentUrl: result.url,
          });
          ui.success(
            theme.success(
              `✓ Posted: ${result.url ?? location}`,
            ),
          );
          successCount++;
        } else {
          ui.error(
            theme.error(
              `✗ Failed to post ${location}: ${result.error}`,
            ),
          );
        }
      }

      return successCount;
    } catch (error) {
      ui.error(
        theme.error(
          `✗ Failed to post comments to the pull request: ${(error as Error).message}`,
        ),
      );
      return 0;
    }
  }
  ```

- [ ] **Step 4: Simplify `promptAndSendAccepted` to delegate to `executeSendAccepted`**

  Replace the existing `promptAndSendAccepted` body:
  ```ts
  async promptAndSendAccepted(pr: PullRequest): Promise<void> {
    const prKey = getPRKey(pr);
    const comments = await this.cache.getComments(prKey);
    const acceptedComments = comments.filter((c) => c.status === "accepted");

    if (acceptedComments.length === 0) {
      return;
    }

    const shouldSend = await promptToSendCommentsToRemote();

    if (shouldSend) {
      await this.prWorkflow.postCommentsToRemote(pr, acceptedComments);
      ui.success(
        theme.success(
          `✓ Posted ${acceptedComments.length} accepted comment(s) to the pull request`,
        ),
      );
    }
  }
  ```
  With:
  ```ts
  async promptAndSendAccepted(pr: PullRequest): Promise<void> {
    const prKey = getPRKey(pr);
    const comments = await this.cache.getComments(prKey);
    const acceptedComments = comments.filter((c) => c.status === "accepted");

    if (acceptedComments.length === 0) {
      return;
    }

    const shouldSend = await promptToSendCommentsToRemote();

    if (shouldSend) {
      await this.executeSendAccepted(pr);
    }
  }
  ```

- [ ] **Step 5: Run the new tests to verify they pass**

  Run: `bun test src/cli/managers/__tests__/action-executor.test.ts --grep "executeSendAccepted"`
  Expected: all 4 tests PASS

- [ ] **Step 6: Run the full test suite**

  Run: `bun test`
  Expected: all tests PASS

- [ ] **Step 7: Run the linter**

  Run: `bun biome check`
  Expected: no errors (fix any lint issues before committing)

- [ ] **Step 8: Commit**

  ```bash
  git add src/cli/managers/action-executor.ts src/cli/managers/__tests__/action-executor.test.ts
  git commit -m "feat: executeSendAccepted marks posted comments, displays URLs"
  ```
