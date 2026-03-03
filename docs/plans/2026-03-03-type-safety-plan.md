# Type Safety Tightening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate all 29 `any` type usages across 6 production files, replacing them with proper types from existing SDK exports.

**Architecture:** Pure type-annotation changes. No runtime behavior changes. Each file is an independent unit of work. Types come from `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`, and `@xenova/transformers` — all already installed.

**Tech Stack:** TypeScript strict mode, Bun runtime, Biome linter

---

### Task 1: Type Bitbucket API responses

**Files:**
- Modify: `src/git-providers/bitbucket.ts`

**Step 1: Add Bitbucket API response types after the existing `CreatePullRequestCommentAnchor` type (line 27)**

Add these types between line 27 and line 29 (before the class):

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
	anchor?: ReturnType<BitbucketServerGitProvider["normalizeAnchor"]>;
};
```

**Step 2: Replace `any` in `fetchPullRequests()` (lines 56-72)**

Change line 56 from:
```ts
const data: any = await response.json();
```
to:
```ts
const data = (await response.json()) as BitbucketPagedResponse<BitbucketPullRequest>;
```

Change the `.map()` callback (lines 58-72) from `(prObject: unknown)` with `as any` casts to direct typed access:
```ts
return data.values.map(
	(pr): PullRequest => ({
		id: pr.id,
		title: pr.title,
		description: pr.description,
		source: {
			name: pr.fromRef?.displayId,
			commitHash: pr.fromRef?.latestCommit,
		},
		target: {
			name: pr.toRef?.displayId,
			commitHash: pr.toRef?.latestCommit,
		},
	}),
);
```

**Step 3: Replace `any` in `fetchCommits()` (lines 89-90)**

Change lines 89-90 from:
```ts
const data: any = await response.json();
return data.values.map((commit: any) => commit.message);
```
to:
```ts
const data = (await response.json()) as BitbucketPagedResponse<BitbucketCommit>;
return data.values.map((commit) => commit.message);
```

**Step 4: Replace `any` in `createPullRequestComment()` (lines 102, 140)**

Change line 102 from:
```ts
const body: any = {
```
to:
```ts
const body: CreatePullRequestCommentBody = {
```

Change line 140 from:
```ts
const data: any = await response.json();
```
to:
```ts
const data = (await response.json()) as BitbucketCommentResponse;
```

**Step 5: Verify and commit**

Run: `bunx tsc --noEmit && bun biome check`
Expected: No errors

```bash
git add src/git-providers/bitbucket.ts
git commit -m "fix(types): eliminate all any types in bitbucket provider"
```

---

### Task 2: Type Claude Agent SDK messages

**Files:**
- Modify: `src/review/claude-query-executor.ts`

**Step 1: Add SDK type imports**

Change line 1 from:
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
```
to:
```ts
import {
	query,
	type SDKMessage,
	type SDKResultMessage,
	type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
```

Note: `SDKResultMessage` is a union type with `subtype: 'success'` and `subtype: 'error_...'` variants. The `SDKMessage` is the discriminated union of all message types. `PermissionMode` is `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'delegate' | 'dontAsk'`. Check these are exported from the main entrypoint; if not, import from `@anthropic-ai/claude-agent-sdk/entrypoints/agentSdkTypes`.

**Step 2: Fix `ClaudeError` and `ClaudeQueryResult` types (lines 12-20)**

Change `originalError?: any` to `originalError?: unknown` (line 15).

Change `ClaudeQueryResult` (lines 18-20) from:
```ts
export type ClaudeQueryResult<T = any> =
	| { success: true; data: T; messages: any[] }
	| { success: false; error: ClaudeError; messages: any[] };
```
to:
```ts
export type ClaudeQueryResult<T = unknown> =
	| { success: true; data: T; messages: SDKMessage[] }
	| { success: false; error: ClaudeError; messages: SDKMessage[] };
```

**Step 3: Fix handler types (lines 22-25)**

Change from:
```ts
type MessageHandler = (msg: any) => void | Promise<void>;
type FreeFormMessageHandler = (
	msg: any,
) => Promise<"continue" | "stop"> | "continue" | "stop";
```
to:
```ts
type MessageHandler = (msg: SDKMessage) => void | Promise<void>;
type FreeFormMessageHandler = (
	msg: SDKMessage,
) => Promise<"continue" | "stop"> | "continue" | "stop";
```

**Step 4: Fix `canUseTool` input type in `executeStructured` (line 53)**

Change `input: any` to `input: Record<string, unknown>`.

**Step 5: Fix `permissionMode` cast (line 83)**

Change from:
```ts
permissionMode: (config.permissionMode as any) || "default",
```
to:
```ts
permissionMode: (config.permissionMode as PermissionMode) || "default",
```

Also change the `config.permissionMode` parameter type from `permissionMode?: string` to `permissionMode?: PermissionMode` in the method signature (line 50). Do the same for `executeFreeForm` (line 196).

**Step 6: Fix local variables in `executeStructured` (lines 88-90)**

Change from:
```ts
const messages: any[] = [];
let errorDetected: ClaudeError | null = null;
let finalResult: any | null = null;
```
to:
```ts
const messages: SDKMessage[] = [];
let errorDetected: ClaudeError | null = null;
let finalResult: SDKResultMessage | null = null;
```

Then fix the `msg.type === "result"` block (line 111-112). Since `msg` is now `SDKMessage`, TypeScript knows that when `msg.type === "result"`, msg is `SDKResultMessage`. Change:
```ts
if (msg.type === "result") {
	finalResult = msg;
```
This should now type-check since `SDKMessage` is a discriminated union on `type`.

For the `msg.subtype` check on line 116, this should work as-is since `SDKResultMessage` has `subtype`.

For `msg.error` check in `detectError` — note that `SDKAssistantMessage` has an `error` field. The `detectError` method accesses `msg.error` and `msg.message?.content`. This needs narrowing. Update `detectError` (see Step 8).

**Step 7: Fix local variables in `executeFreeForm` (line 223)**

Change `const messages: any[] = [];` to `const messages: SDKMessage[] = [];`.

Fix the `permissionMode` cast on line 219 same as Step 5.

**Step 8: Fix `detectError` method (line 293)**

Change signature from `private detectError(msg: any)` to `private detectError(msg: SDKMessage)`.

The method body accesses `msg.error` and `msg.message?.content`. These only exist on `SDKAssistantMessage`. Rewrite with narrowing:

```ts
private detectError(msg: SDKMessage): ClaudeError | null {
	if (msg.type === "assistant" && msg.error) {
		const errorType = msg.error;
		const content = msg.message?.content;
		const errorMessage =
			(Array.isArray(content) &&
				content[0] &&
				"type" in content[0] &&
				content[0].type === "text" &&
				"text" in content[0] &&
				content[0].text) ||
			errorType ||
			"Unknown error";

		switch (errorType) {
			case "billing_error":
				return { type: "billing_error", message: errorMessage, originalError: msg };
			case "authentication_failed":
				return { type: "authentication_error", message: errorMessage, originalError: msg };
			case "rate_limit":
				return { type: "rate_limit_error", message: errorMessage, originalError: msg };
			case "server_error":
				return { type: "api_error", message: errorMessage, originalError: msg };
			default:
				return { type: "unknown_error", message: errorMessage, originalError: msg };
		}
	}

	// Check for billing error in message content
	if (msg.type === "assistant") {
		const content = msg.message?.content;
		if (Array.isArray(content)) {
			for (const block of content) {
				if (
					"type" in block &&
					block.type === "text" &&
					"text" in block &&
					block.text?.includes("Credit balance is too low")
				) {
					return {
						type: "billing_error",
						message: "Credit balance is too low",
						originalError: msg,
					};
				}
			}
		}
	}

	return null;
}
```

Note: The SDK's `SDKAssistantMessageError` uses `'authentication_failed'` not `'authentication_error'`, `'rate_limit'` not `'rate_limit_error'`, and `'server_error'` not `'api_error'`. The switch cases should match what the SDK actually sends. Verify the current switch values match the SDK enum and adjust if needed (map SDK values to our `ClaudeErrorType`).

**Step 9: Fix `isSyntheticMessage` method (line 365)**

Change from `private isSyntheticMessage(msg: any)` to `private isSyntheticMessage(msg: SDKMessage)`.

The `isSynthetic` property exists on `SDKUserMessage` (and `SDKUserMessageReplay`). Use narrowing:

```ts
private isSyntheticMessage(msg: SDKMessage): boolean {
	return msg.type === "user" && msg.isSynthetic === true;
}
```

**Step 10: Verify and commit**

Run: `bunx tsc --noEmit && bun biome check`
Expected: No errors

```bash
git add src/review/claude-query-executor.ts
git commit -m "fix(types): eliminate all any types in claude query executor"
```

---

### Task 3: Type content blocks in comment fixer

**Files:**
- Modify: `src/review/comment-fixer.ts`

**Step 1: Add content block type imports**

After line 2, add:

```ts
import type {
	BetaTextBlock,
	BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
```

Also import `SDKMessage` from the agent SDK for the `onMessage` callback:

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
```

**Step 2: Fix `as any` for text blocks (line 173)**

Change from:
```ts
if (block.type === "text" && "text" in block) {
	const text = (block as any).text.trim();
```
to:
```ts
if (block.type === "text" && "text" in block) {
	const text = (block as BetaTextBlock).text.trim();
```

**Step 3: Fix `as any` for tool_use blocks (lines 186-214)**

Change from:
```ts
if (block.type === "tool_use" && "name" in block) {
	const toolBlock = block as any;
```
to:
```ts
if (block.type === "tool_use" && "name" in block) {
	const toolBlock = block as BetaToolUseBlock;
```

Then fix property accesses. `BetaToolUseBlock.input` is `unknown`, so:
- `toolBlock.input?.path` needs to become `(toolBlock.input as Record<string, unknown>)?.path` or better: extract a helper to get the input as a record.

Add a private helper method:

```ts
private getToolInput(block: BetaToolUseBlock): Record<string, unknown> {
	return (typeof block.input === "object" && block.input !== null
		? block.input
		: {}) as Record<string, unknown>;
}
```

Then replace `toolBlock.input` accesses with `this.getToolInput(toolBlock)`:
```ts
const input = this.getToolInput(toolBlock);
// ...
message: `About to edit: ${(input.path as string) || "file"}`,
// ...
message: this.describeToolUse(toolName, input),
// ...
if (toolName === "Edit" && input.path) {
	filesModified.add(input.path as string);
}
```

**Step 4: Fix `as any` for tool_result blocks (lines 244-249)**

Change from:
```ts
if ((block as any).type === "tool_result") {
	const resultBlock = block as any;
	const resultText =
		typeof resultBlock.content === "string"
			? resultBlock.content
			: JSON.stringify(resultBlock.content);
```
to:
```ts
if ("type" in block && block.type === "tool_result") {
	const resultBlock = block as { type: "tool_result"; content?: string | unknown[] };
	const resultText =
		typeof resultBlock.content === "string"
			? resultBlock.content
			: JSON.stringify(resultBlock.content);
```

Note: The user message content blocks for tool results use `BetaToolResultBlockParam` shape. The `content` field is `string | Array<...>`. We use a minimal inline type since importing the full param type may introduce unnecessary coupling.

**Step 5: Fix `describeToolUse` method (line 284)**

Change from:
```ts
private describeToolUse(toolName: string, input: any): string {
```
to:
```ts
private describeToolUse(toolName: string, input: Record<string, unknown>): string {
```

Then fix property accesses to cast to string:
```ts
case "Read":
	return `Reading ${(input.path as string) || "file"}`;
case "Edit":
	return `Editing ${(input.path as string) || "file"}`;
case "Grep":
	return `Searching for "${(input.pattern as string) || "pattern"}"`;
case "Glob":
	return `Finding files: ${(input.pattern as string) || "pattern"}`;
```

**Step 6: Verify and commit**

Run: `bunx tsc --noEmit && bun biome check`
Expected: No errors

```bash
git add src/review/comment-fixer.ts
git commit -m "fix(types): eliminate all any types in comment fixer"
```

---

### Task 4: Type LangGraph stream chunk in context gatherer

**Files:**
- Modify: `src/review/context-gatherer.ts`

**Step 1: Add stream chunk type and replace `as any` (line 132)**

Add a type near the top of the file (after imports):

```ts
type LangGraphUpdateChunk = {
	messages: unknown[];
};
```

Change line 132 from:
```ts
const [_, content] = Object.entries(chunk)[0] as any;
```
to:
```ts
const entries = Object.entries(chunk);
if (entries.length === 0) continue;
const [, content] = entries[0] as [string, LangGraphUpdateChunk];
```

**Step 2: Verify and commit**

Run: `bunx tsc --noEmit && bun biome check`
Expected: No errors

```bash
git add src/review/context-gatherer.ts
git commit -m "fix(types): eliminate any type in context gatherer stream processing"
```

---

### Task 5: Type embedder pipeline

**Files:**
- Modify: `src/memory/embedder.ts`

**Step 1: Import and use proper pipeline type**

Check if `FeatureExtractionPipeline` is directly importable:

```ts
import type { FeatureExtractionPipeline } from "@xenova/transformers";
```

If the import works, change line 5 from:
```ts
private pipeline: any | null = null;
```
to:
```ts
private pipeline: FeatureExtractionPipeline | null = null;
```

If the import doesn't resolve (JSDoc-based types can be finicky), use the return type of the `pipeline()` function instead. The `pipeline()` function from `@xenova/transformers` returns `Promise<AllTasks[T]>` where `T = "feature-extraction"` maps to `FeatureExtractionPipeline`. As a fallback, use the callable interface:

```ts
type EmbeddingPipeline = (
	text: string,
	options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: ArrayLike<number> }>;

private pipeline: EmbeddingPipeline | null = null;
```

**Step 2: Verify and commit**

Run: `bunx tsc --noEmit && bun biome check`
Expected: No errors

```bash
git add src/memory/embedder.ts
git commit -m "fix(types): eliminate any type in embedder pipeline"
```

---

### Task 6: Final verification

**Step 1: Full type check**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 2: Grep for remaining `any`**

Run: `grep -rn ': any\|as any\|any\[' src/ --include='*.ts' | grep -v node_modules | grep -v '.test.ts' | grep -v '__tests__'`
Expected: Zero matches (or only justified exceptions)

**Step 3: Biome check**

Run: `bun biome check`
Expected: No errors
