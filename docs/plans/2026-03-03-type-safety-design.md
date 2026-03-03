# Type Safety Tightening Design

## Problem

The codebase has 29 `any` type usages across 6 production files, undermining TypeScript's strict mode guarantees. All are eliminable using types already exported by dependencies.

## Scope

Production code only. Test files (`*.test.ts`) deferred to a follow-up.

## Changes by File

### 1. `src/git-providers/bitbucket.ts` (14 `any` eliminated)

Define Bitbucket API response types:

```ts
type BitbucketRef = {
  displayId: string;
  latestCommit: string;
};

type BitbucketPullRequest = {
  id: number;
  title: string;
  description: string;
  fromRef: BitbucketRef;
  toRef: BitbucketRef;
};

type BitbucketPagedResponse<T> = {
  values: T[];
  size: number;
  isLastPage: boolean;
};

type BitbucketCommit = {
  message: string;
};

type BitbucketCommentResponse = {
  id: number;
};

type CreatePullRequestCommentBody = {
  text: string;
  severity: string;
  version: number;
  threadResolved: boolean;
  parent?: { id: number };
  anchor?: { path: string; line?: number; lineType?: LineType; fileType?: FileType };
};
```

Replace:
- `const data: any = await response.json()` -> typed paged responses
- `(prObject as any).field` -> typed `BitbucketPullRequest` parameter
- `(commit: any)` -> typed `BitbucketCommit`
- `const body: any` -> `CreatePullRequestCommentBody`

### 2. `src/review/claude-query-executor.ts` (12 `any` eliminated)

Import SDK types:

```ts
import type {
  SDKMessage,
  SDKResultMessage,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
```

Replace:
- `originalError?: any` -> `originalError?: unknown`
- `messages: any[]` -> `messages: SDKMessage[]` in `ClaudeQueryResult`
- `MessageHandler = (msg: any)` -> `(msg: SDKMessage)`
- `FreeFormMessageHandler = (msg: any)` -> `(msg: SDKMessage)`
- `const messages: any[] = []` -> `SDKMessage[]`
- `let finalResult: any | null` -> `SDKResultMessage | null`
- `detectError(msg: any)` -> `detectError(msg: SDKMessage)`
- `isSyntheticMessage(msg: any)` -> `isSyntheticMessage(msg: SDKMessage)`
- `(config.permissionMode as any)` -> `config.permissionMode as PermissionMode`
- `canUseTool` input `any` -> `Record<string, unknown>`

### 3. `src/review/comment-fixer.ts` (6 `any` eliminated)

Import content block types from the Anthropic SDK (re-exported through agent SDK):

```ts
import type {
  BetaTextBlock,
  BetaToolUseBlock,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
```

Replace:
- `(block as any).text` -> narrow with `block as BetaTextBlock` after type check
- `block as any` for tool_use -> `block as BetaToolUseBlock`
- `(block as any).type === "tool_result"` -> proper discriminated union check
- `describeToolUse(_, input: any)` -> `input: Record<string, unknown> | undefined`

### 4. `src/review/context-gatherer.ts` (1 `any` eliminated)

Replace `Object.entries(chunk)[0] as any` with:

```ts
type LangGraphStreamChunk = {
  messages: unknown[];
};

const entries = Object.entries(chunk);
if (entries.length === 0) continue;
const [, content] = entries[0] as [string, LangGraphStreamChunk];
```

### 5. `src/memory/embedder.ts` (1 `any` eliminated)

Import proper pipeline type:

```ts
import type { FeatureExtractionPipeline } from "@xenova/transformers";
private pipeline: FeatureExtractionPipeline | null = null;
```

## Justified exceptions

None. All 29 `any` usages are eliminable.

## Risks

- **Low**: All changes are type annotations only, zero runtime behavior changes.
- SDK types are already shipped as `.d.ts` files, no new dependencies needed.
