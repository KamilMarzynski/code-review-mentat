# Memory Retrieval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable the code review tool to retrieve past review memories from the vector database and inject them into new reviews, so the tool learns from previous findings.

**Architecture:** Two-part change — (1) vector search in the data/service layer (MemoryStore + MemoryService), (2) LLM query generation + integration into the review workflow via ActionExecutor and Orchestrator. Memory retrieval is a transparent pre-review step that always runs before code review and caches results.

**Tech Stack:** Bun, TypeScript, sqlite-vec (KNN search), OpenRouter API (Sonnet for query generation), existing Embedder (mxbai-embed-large-v1)

**Design doc:** `docs/plans/2026-03-02-memory-retrieval-design.md`

---

### Task 1: Add new types to `src/memory/types.ts`

**Files:**
- Modify: `src/memory/types.ts:33` (append after `CreateMemoryResult`)

**Step 1: Add the three new types**

Append after line 33 (end of `CreateMemoryResult`):

```typescript
export type MemorySearchOptions = {
	maxDistance: number;
	limit?: number;
};

export type MemorySearchResult = {
	id: string;
	situation: string;
	lesson: string;
	fileExtension: string;
	projectName: string | null;
	severity: string;
	distance: number;
};

export type MemoryQueryInput = {
	context?: string;
	editedFiles: string[];
	commits: string[];
	diff: string;
	sourceBranch: string;
	targetBranch: string;
};
```

**Step 2: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 3: Commit**

```bash
git add src/memory/types.ts
git commit -m "feat(memory): add search and query input types"
```

---

### Task 2: Add `search()` method to `MemoryStore`

**Files:**
- Modify: `src/memory/memory-store.ts:89` (add method before `close()`)

**Step 1: Add the import for the new type**

At `src/memory/memory-store.ts:4`, change:

```typescript
import type { MemoryDocument } from "./types";
```

to:

```typescript
import type { MemoryDocument, MemorySearchOptions, MemorySearchResult } from "./types";
```

**Step 2: Add the search method before `close()` (before line 90)**

Insert before the `close()` method:

```typescript
	search(embedding: Float32Array, options: MemorySearchOptions): MemorySearchResult[] {
		const limit = options.limit ?? 10;

		const stmt = this.db.prepare(`
			SELECT m.id, m.situation, m.lesson, m.file_extension, m.project_name, m.severity, v.distance
			FROM memories_vec v
			JOIN memories m ON m.id = v.id
			WHERE v.embedding MATCH ?
				AND v.distance <= ?
			ORDER BY v.distance
			LIMIT ?
		`);

		const embeddingBytes = new Uint8Array(
			embedding.buffer,
			embedding.byteOffset,
			embedding.byteLength,
		);

		const rows = stmt.all(embeddingBytes, options.maxDistance, limit) as Array<{
			id: string;
			situation: string;
			lesson: string;
			file_extension: string;
			project_name: string | null;
			severity: string;
			distance: number;
		}>;

		return rows.map((row) => ({
			id: row.id,
			situation: row.situation,
			lesson: row.lesson,
			fileExtension: row.file_extension,
			projectName: row.project_name,
			severity: row.severity,
			distance: row.distance,
		}));
	}
```

**Step 3: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 4: Commit**

```bash
git add src/memory/memory-store.ts
git commit -m "feat(memory): add vector search method to MemoryStore"
```

---

### Task 3: Add `searchMemories()` to `MemoryService`

**Files:**
- Modify: `src/memory/memory-service.ts:7-11` (add import), append method before `close()`

**Step 1: Update imports**

At `src/memory/memory-service.ts:7-11`, change:

```typescript
import type {
	CreateMemoryInput,
	CreateMemoryResult,
	MemoryServiceConfig,
} from "./types";
```

to:

```typescript
import type {
	CreateMemoryInput,
	CreateMemoryResult,
	MemorySearchOptions,
	MemorySearchResult,
	MemoryServiceConfig,
} from "./types";
```

**Step 2: Add searchMemories method before `close()` (before line 92)**

Insert before the `close()` method:

```typescript
	async searchMemories(
		query: string | string[],
		options: MemorySearchOptions,
	): Promise<MemorySearchResult[]> {
		await this.ensureInitialized();

		const store = this.store;
		if (!store) {
			throw new Error("MemoryStore not initialized");
		}

		const queries = Array.isArray(query) ? query : [query];
		const allResults: MemorySearchResult[] = [];

		for (const q of queries) {
			const embedding = await this.embedder.embed(q);
			const results = store.search(embedding, options);
			allResults.push(...results);
		}

		// Deduplicate by ID, keeping best (lowest) distance
		const bestByID = new Map<string, MemorySearchResult>();
		for (const result of allResults) {
			const existing = bestByID.get(result.id);
			if (!existing || result.distance < existing.distance) {
				bestByID.set(result.id, result);
			}
		}

		const deduplicated = Array.from(bestByID.values());
		deduplicated.sort((a, b) => a.distance - b.distance);

		const limit = options.limit ?? 10;
		return deduplicated.slice(0, limit);
	}
```

**Step 3: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 4: Commit**

```bash
git add src/memory/memory-service.ts
git commit -m "feat(memory): add searchMemories with multi-query dedup"
```

---

### Task 4: Create `MemoryQueryGenerator`

**Files:**
- Create: `src/memory/query-generator.ts`
- Create: `src/prompts/memory-query/v1.md` (placeholder)

**Step 1: Create the prompt placeholder**

Create directory `src/prompts/memory-query/` and file `v1.md`:

```markdown
<!-- Placeholder: user will provide actual prompt content -->
<!-- Variables: {{context}}, {{editedFiles}}, {{commits}}, {{diff}}, {{sourceBranch}}, {{targetBranch}} -->

You are a memory query generator. Based on the following code review context, generate search queries to find relevant past review memories.

Respond with a JSON array of query strings. Each query should be 25-60 words describing a code review situation or pattern.

## Context
{{context}}

## Edited Files
{{editedFiles}}

## Commits
{{commits}}

## Source Branch
{{sourceBranch}} -> {{targetBranch}}

## Diff
{{diff}}
```

**Step 2: Create the query generator class**

Create `src/memory/query-generator.ts`:

```typescript
import { loadPrompt } from "../prompts/loader";
import type { LLMClient } from "./llm-client";
import type { MemoryQueryInput } from "./types";

export class MemoryQueryGenerator {
	constructor(private llm: LLMClient) {}

	async generateQueries(input: MemoryQueryInput): Promise<string[]> {
		const prompt = loadPrompt(
			{ name: "memory-query", version: "latest" },
			{
				context: input.context ?? "No context gathered.",
				editedFiles: input.editedFiles.map((f) => `- ${f}`).join("\n"),
				commits: input.commits.map((c) => `- ${c}`).join("\n"),
				diff: input.diff,
				sourceBranch: input.sourceBranch,
				targetBranch: input.targetBranch,
			},
		);

		const response = await this.llm.complete(
			prompt,
			"Generate memory search queries.",
		);

		return this.parseQueries(response);
	}

	private parseQueries(response: string): string[] {
		const jsonMatch = response.match(/\[[\s\S]*\]/);
		if (!jsonMatch) {
			throw new Error("Failed to parse query response: no JSON array found");
		}

		const parsed = JSON.parse(jsonMatch[0]);
		if (!Array.isArray(parsed)) {
			throw new Error("Failed to parse query response: not an array");
		}

		return parsed.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
	}
}
```

**Step 3: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 4: Commit**

```bash
git add src/memory/query-generator.ts src/prompts/memory-query/v1.md
git commit -m "feat(memory): add MemoryQueryGenerator with prompt template"
```

---

### Task 5: Add memory cache methods to `LocalCache`

**Files:**
- Modify: `src/cache/local-cache.ts:1` (add import), `src/cache/local-cache.ts:18-37` (update `CachedContext`), add two new methods

**Step 1: Add import for MemorySearchResult**

At `src/cache/local-cache.ts:13`, change:

```typescript
import type { ReviewComment, StoredReviewComment } from "../review/types";
```

to:

```typescript
import type { MemorySearchResult } from "../memory/types";
import type { ReviewComment, StoredReviewComment } from "../review/types";
```

**Step 2: Add memory fields to CachedContext**

At `src/cache/local-cache.ts:35-37`, change:

```typescript
	comments?: StoredReviewComment[];
	reviewedAt?: string;
};
```

to:

```typescript
	comments?: StoredReviewComment[];
	reviewedAt?: string;
	memories?: MemorySearchResult[];
	memoriesRetrievedAt?: string;
};
```

**Step 3: Add getMemories method**

Add after the `getMetadata` method (after line 263), before the `clear` method:

```typescript
	/**
	 * Get cached memories for this MR (null if not retrieved yet)
	 */
	getMemories(input: {
		mrNumber?: string;
		sourceBranch: string;
		targetBranch: string;
	}): MemorySearchResult[] | null {
		const key = this.getCacheKey(input);
		const cachePath = this.getCachePath(key);

		if (!existsSync(cachePath)) {
			return null;
		}

		try {
			const cached: CachedContext = JSON.parse(
				readFileSync(cachePath, "utf-8"),
			);
			return cached.memories ?? null;
		} catch {
			return null;
		}
	}
```

**Step 4: Add saveMemories method**

Add immediately after `getMemories`:

```typescript
	/**
	 * Save retrieved memories for this MR
	 */
	saveMemories(
		input: {
			mrNumber?: string;
			sourceBranch: string;
			targetBranch: string;
		},
		memories: MemorySearchResult[],
	): void {
		const key = this.getCacheKey(input);
		const cachePath = this.getCachePath(key);

		let cached: CachedContext;
		if (existsSync(cachePath)) {
			try {
				cached = JSON.parse(readFileSync(cachePath, "utf-8"));
			} catch {
				return; // Don't overwrite if we can't parse
			}
		} else {
			return; // No cache file exists — nothing to attach memories to
		}

		cached.memories = memories;
		cached.memoriesRetrievedAt = new Date().toISOString();

		writeFileSync(cachePath, JSON.stringify(cached, null, 2), "utf-8");
	}
```

**Step 5: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 6: Commit**

```bash
git add src/cache/local-cache.ts
git commit -m "feat(cache): add memory retrieval caching to LocalCache"
```

---

### Task 6: Add `hasMemories` to WorkflowState and update state detection

**Files:**
- Modify: `src/cli/types.ts:29-49` (add field to `WorkflowState`)
- Modify: `src/cli/managers/workflow-state-manager.ts:24-81` (detect `hasMemories`)

**Step 1: Add `hasMemories` to WorkflowState**

At `src/cli/types.ts:46`, after the `rejectedCount: number;` line, add:

```typescript
	// Memory state
	hasMemories: boolean;
```

**Step 2: Update `detectState` in WorkflowStateManager**

At `src/cli/managers/workflow-state-manager.ts`, after the `hasNewCommits` calculation (around line 63-65), add:

```typescript
		// Check memory state
		const memories = this.cache.getMemories(cacheInput);
		const hasMemories = memories !== null;
```

Then update the return object (around line 67-81) to include:

```typescript
		hasMemories,
```

Add it after `hasNewCommits` in the return object.

**Step 3: Update all test objects in `workflow-state-manager.test.ts`**

Every `WorkflowState` object literal in the test file needs `hasMemories: false` added. There are multiple instances — add the field to each state object that doesn't have it.

**Step 4: Verify types compile and tests pass**

Run: `bunx tsc --noEmit --pretty`
Run: `bun test src/cli/managers/__tests__/workflow-state-manager.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add src/cli/types.ts src/cli/managers/workflow-state-manager.ts src/cli/managers/__tests__/workflow-state-manager.test.ts
git commit -m "feat(cli): add hasMemories to workflow state detection"
```

---

### Task 7: Add `memories` to `ReviewInput` and wire into `CodeReviewer`

**Files:**
- Modify: `src/review/types.ts:53-61` (add field to `ReviewInput`)
- Modify: `src/review/code-reviewer.ts:223-231` (update `buildPrompt`)

**Step 1: Add import for MemorySearchResult to review types**

At `src/review/types.ts:1`, after the existing import, add:

```typescript
import type { MemorySearchResult } from "../memory/types";
```

**Step 2: Add memories field to ReviewInput**

At `src/review/types.ts:60`, before `sourceHash: string;`, add:

```typescript
	memories?: MemorySearchResult[];
```

**Step 3: Update `buildPrompt` in `CodeReviewer`**

At `src/review/code-reviewer.ts:223-231`, change `buildPrompt`:

```typescript
	private buildPrompt(input: ReviewInput): string {
		return loadPrompt(CodeReviewer.PROMPT_CONFIG, {
			contextGuidance: this.buildContextGuidance(input.context),
			memoriesGuidance: this.buildMemoriesGuidance(input.memories),
			editedFilesCount: String(input.editedFiles.length),
			editedFilesList: input.editedFiles.map((f) => `- ${f}`).join("\n"),
			commitsList: input.commits.map((c) => `- ${c}`).join("\n"),
			diff: input.diff,
		});
	}
```

**Step 4: Add `buildMemoriesGuidance` method after `buildContextGuidance`**

```typescript
	private buildMemoriesGuidance(
		memories: ReviewInput["memories"],
	): string {
		if (!memories || memories.length === 0) {
			return "";
		}

		const memoriesList = memories
			.map(
				(m, i) =>
					`${i + 1}. [${m.severity}] ${m.situation}\n   Lesson: ${m.lesson}`,
			)
			.join("\n");

		return [
			"## Past Review Memories",
			"The following lessons were learned from previous code reviews of similar code.",
			"Use them to inform your review — check if the same patterns or issues appear in this PR:",
			"",
			memoriesList,
		].join("\n");
	}
```

**Step 5: Update the code-review prompt template**

At `src/prompts/code-review/v1.md:1-8`, update the variable comment block to include `{{memoriesGuidance}}`:

Change line 3 to:
```
  {{contextGuidance}}    - Jira/Confluence context section (empty string when no context)
  {{memoriesGuidance}}   - Past review memories section (empty string when no memories)
```

At line 108, after `{{contextGuidance}}`, add:

```
{{memoriesGuidance}}
```

So lines 108-109 become:

```
{{contextGuidance}}

{{memoriesGuidance}}
```

**Step 6: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 7: Commit**

```bash
git add src/review/types.ts src/review/code-reviewer.ts src/prompts/code-review/v1.md
git commit -m "feat(review): inject retrieved memories into code review prompt"
```

---

### Task 8: Add `executeRetrieveMemories` to `ActionExecutor`

**Files:**
- Modify: `src/cli/managers/action-executor.ts` (add imports, constructor params, new method)

**Step 1: Add imports**

At `src/cli/managers/action-executor.ts:1-2`, add:

```typescript
import type { MemoryQueryGenerator } from "../../memory/query-generator";
import type { MemoryService } from "../../memory/memory-service";
```

**Step 2: Update constructor to accept new dependencies**

At `src/cli/managers/action-executor.ts:34-42`, change constructor:

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
	) {}
```

**Step 3: Add `executeRetrieveMemories` method**

Add after the `executeGatherContext` method (after line 159), before `executeReview`:

```typescript
	/**
	 * Retrieve past review memories from vector database
	 *
	 * Short-circuits if memories already cached for this PR.
	 * Generates search queries via LLM, then searches vector DB.
	 */
	async executeRetrieveMemories(pr: PullRequest): Promise<void> {
		const cacheInput = {
			sourceBranch: pr.source.name,
			targetBranch: pr.target.name,
		};

		// Short-circuit if memories already cached
		const cached = this.cache.getMemories(cacheInput);
		if (cached !== null) {
			if (cached.length > 0) {
				ui.info(
					theme.muted(
						`Using ${cached.length} cached memory/memories from previous retrieval`,
					),
				);
			}
			return;
		}

		const spinner = ui.spinner();

		try {
			spinner.start(
				theme.accent("Retrieving past review memories"),
			);

			// Fetch PR metadata for query generation
			const commitMessages = await this.prWorkflow.fetchCommitHistory(pr);
			const { fullDiff, editedFiles } =
				await this.prWorkflow.analyzeChanges(pr);

			// Load context from cache (may be null if user skipped context gathering)
			const cachedContext = this.cache.get(cacheInput);

			// Generate search queries via LLM
			const queries = await this.memoryQueryGenerator.generateQueries({
				context: cachedContext ?? undefined,
				editedFiles,
				commits: commitMessages,
				diff: fullDiff,
				sourceBranch: pr.source.name,
				targetBranch: pr.target.name,
			});

			// Search vector database
			const memories = await this.memoryService.searchMemories(queries, {
				maxDistance: 0.8,
				limit: 10,
			});

			// Cache results (even if empty, to prevent re-querying)
			this.cache.saveMemories(cacheInput, memories);

			if (memories.length > 0) {
				spinner.stop(
					theme.success(
						`✓ Found ${memories.length} relevant memory/memories from past reviews`,
					),
				);
			} else {
				spinner.stop(
					theme.muted("No relevant memories found from past reviews"),
				);
			}
		} catch (error) {
			spinner.stop(
				theme.warning("⚠ Memory retrieval failed (continuing without memories)"),
			);
			ui.info(theme.muted(`   ${(error as Error).message}`));

			// Cache empty array to prevent re-querying on failure
			this.cache.saveMemories(cacheInput, []);
		}
	}
```

**Step 4: Update `executeReview` to load and pass memories**

In `executeReview`, after loading `cachedContext` (around line 221-222), add:

```typescript
			// Load memories from cache if available
			const memories = this.cache.getMemories(cacheInput) ?? undefined;
```

Then update the `reviewInput` object (around line 224-231) to include memories:

```typescript
			const reviewInput = {
				context: cachedContext || undefined,
				memories,
				editedFiles,
				commits: commitMessages,
				diff: fullDiff,
				sourceBranch: pr.source.name,
				targetBranch: pr.target.name,
				sourceHash: pr.source.commitHash,
			};
```

**Step 5: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 6: Commit**

```bash
git add src/cli/managers/action-executor.ts
git commit -m "feat(cli): add memory retrieval step to action executor"
```

---

### Task 9: Wire memory retrieval into Orchestrator

**Files:**
- Modify: `src/cli/orchestrator.ts:143-178` (update `executeAction`)

**Step 1: Update `executeAction` to call memory retrieval before review**

At `src/cli/orchestrator.ts:143-178`, change:

```typescript
	private async executeAction(
		action: WorkflowAction,
		context: SetupContext,
	): Promise<void> {
		switch (action) {
			case "gather_context":
			case "refresh_context":
				await this.actionExecutor.executeGatherContext(context.pr);
				break;

			case "run_review":
				await this.actionExecutor.executeRetrieveMemories(context.pr);
				await this.actionExecutor.executeReview(context.pr);
				break;

			case "review_with_context":
				// First gather context
				await this.actionExecutor.executeGatherContext(context.pr);
				// Then retrieve memories (uses context for better queries)
				await this.actionExecutor.executeRetrieveMemories(context.pr);
				// Then run review
				await this.actionExecutor.executeReview(context.pr);
				break;

			case "handle_pending":
				await this.actionExecutor.executeHandlePending(context.pr);
				break;

			case "send_accepted":
				await this.actionExecutor.executeSendAccepted(context.pr);
				break;

			case "exit":
				// Should not reach here (handled in menuLoop)
				break;

			default:
				throw new Error(`Unknown action: ${action}`);
		}
	}
```

**Step 2: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 3: Commit**

```bash
git add src/cli/orchestrator.ts
git commit -m "feat(cli): wire memory retrieval before review in orchestrator"
```

---

### Task 10: Wire dependency injection in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (add imports, create instances, update constructor call)

**Step 1: Add imports**

At `src/index.ts:16-17`, after the existing memory import, add:

```typescript
import { LLMClient } from "./memory/llm-client";
import { MemoryQueryGenerator } from "./memory/query-generator";
```

**Step 2: Create Sonnet LLM client and query generator**

After the `memoryService` creation (after line 84), add:

```typescript
	// Sonnet LLM client for memory query generation
	const sonnetLLMClient = new LLMClient(
		OPENROUTER_API_KEY,
		"anthropic/claude-sonnet-4.6",
	);
	const memoryQueryGenerator = new MemoryQueryGenerator(sonnetLLMClient);
```

**Step 3: Update ActionExecutor constructor call**

At `src/index.ts:132-140`, change:

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
	);
```

**Step 4: Verify types compile**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire memory retrieval dependencies in DI setup"
```

---

### Task 11: Update existing tests for new ActionExecutor constructor

**Files:**
- Modify: `src/cli/managers/__tests__/action-executor.test.ts` (update mock constructor)
- Modify: `src/cli/__tests__/orchestrator.test.ts` (update if ActionExecutor is mocked)

**Step 1: Read and update action-executor tests**

In `src/cli/managers/__tests__/action-executor.test.ts`, find where `ActionExecutor` is constructed and add mock `memoryService` and `memoryQueryGenerator` as the 8th and 9th parameters:

```typescript
const mockMemoryService = {
	searchMemories: mock(async () => []),
} as unknown as MemoryService;

const mockMemoryQueryGenerator = {
	generateQueries: mock(async () => []),
} as unknown as MemoryQueryGenerator;
```

Pass them to the constructor.

**Step 2: Read and update orchestrator tests if needed**

Check `src/cli/__tests__/orchestrator.test.ts` — if it mocks `ActionExecutor`, add `executeRetrieveMemories` to the mock.

**Step 3: Run all tests**

Run: `bun test`
Expected: All pass

**Step 4: Commit**

```bash
git add src/cli/managers/__tests__/action-executor.test.ts src/cli/__tests__/orchestrator.test.ts
git commit -m "test: update tests for new ActionExecutor dependencies"
```

---

### Task 12: Run full lint and type check

**Files:** None (validation only)

**Step 1: Run biome lint**

Run: `bun biome check`
Expected: No errors (or only pre-existing ones)

**Step 2: Run TypeScript type check**

Run: `bunx tsc --noEmit --pretty`
Expected: No errors

**Step 3: Run all tests**

Run: `bun test`
Expected: All pass

**Step 4: If issues found, fix them and commit**

```bash
git add -A
git commit -m "fix: address lint and type errors from memory retrieval"
```
