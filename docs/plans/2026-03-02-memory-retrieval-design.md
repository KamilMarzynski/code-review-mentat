# Memory Retrieval for Code Review

**Date**: 2026-03-02
**Status**: Approved

## Overview

Add the ability to retrieve past review memories from the vector database and inject them into the code review process. This allows the tool to learn from previous reviews and apply past lessons to new reviews of the same or similar codebases.

## Architecture

Memory retrieval is a **transparent pre-review step** that always runs before code review. It generates semantic search queries from PR metadata and optional context, searches the vector DB for relevant past memories, caches results, and passes them to the code reviewer.

## Part 1: Vector Search (Data + Service Layer)

### New Types (`src/memory/types.ts`)

```typescript
type MemorySearchOptions = {
  maxDistance: number;     // Vector distance threshold (e.g. 0.8)
  limit?: number;         // Max results to return (default: 10)
};

type MemorySearchResult = {
  id: string;
  situation: string;
  lesson: string;
  fileExtension: string;
  projectName: string | null;
  severity: string;
  distance: number;       // Vector distance (lower = more similar)
};
```

### MemoryStore.search() (`src/memory/memory-store.ts`)

New method using sqlite-vec KNN query:

```sql
SELECT m.id, m.situation, m.lesson, m.file_extension, m.project_name, m.severity, v.distance
FROM memories_vec v
JOIN memories m ON m.id = v.id
WHERE v.embedding MATCH ?
  AND v.distance <= ?
ORDER BY v.distance
LIMIT ?
```

### MemoryService.searchMemories() (`src/memory/memory-service.ts`)

```typescript
async searchMemories(
  query: string | string[],
  options: MemorySearchOptions
): Promise<MemorySearchResult[]>
```

- Accepts `string | string[]` (both overloads)
- Normalizes to array, embeds each query, runs parallel KNN searches
- Deduplicates by ID, keeps **best (lowest) distance** per memory
- Sorts by distance ascending, applies final limit

## Part 2: Query Generation + Integration

### MemoryQueryGenerator (`src/memory/query-generator.ts` — new file)

```typescript
class MemoryQueryGenerator {
  constructor(llmClient: LLMClient)  // Sonnet model

  async generateQueries(input: MemoryQueryInput): Promise<string[]>
}
```

Input type:
```typescript
type MemoryQueryInput = {
  context?: string;        // From context gatherer (may be absent)
  editedFiles: string[];
  commits: string[];
  diff: string;
  sourceBranch: string;
  targetBranch: string;
};
```

- Loads prompt from `src/prompts/memory-query/v1.md` (user provides content)
- Calls Sonnet via `LLMClient.complete()`
- Parses JSON array response → returns `string[]`

### Cache Changes (`src/cache/local-cache.ts`)

Add to `CachedContext`:
```typescript
memories?: MemorySearchResult[];
memoriesRetrievedAt?: string;
```

New methods:
- `getMemories(input): MemorySearchResult[] | null`
- `saveMemories(input, memories): void`

### ActionExecutor.executeRetrieveMemories() (`src/cli/managers/action-executor.ts`)

Flow:
1. Check cache — if memories already exist for this PR, **skip** (short-circuit)
2. Fetch PR metadata (commits, editedFiles, diff) via prWorkflow
3. Load context from cache (may be null)
4. Call `MemoryQueryGenerator.generateQueries()` with PR metadata + optional context
5. Call `MemoryService.searchMemories()` with generated queries
6. Save results to cache (even if empty, to prevent re-querying)
7. UI: spinner "Retrieving past review memories..." → result count

### Orchestrator Changes (`src/cli/orchestrator.ts`)

Memory retrieval auto-called before review in both paths:
- `run_review` → `executeRetrieveMemories(pr)` then `executeReview(pr)`
- `review_with_context` → `executeGatherContext(pr)` then `executeRetrieveMemories(pr)` then `executeReview(pr)`

### WorkflowState Changes (`src/cli/types.ts`)

Add `hasMemories: boolean` — informational, shown in menu hints.

### ReviewInput Changes (`src/review/types.ts`)

Add `memories?: MemorySearchResult[]` — passed to code reviewer prompt when available.

### Dependency Injection (`index.ts`)

```typescript
const sonnetLLMClient = new LLMClient(OPENROUTER_API_KEY, "anthropic/claude-sonnet-4.6");
const memoryQueryGenerator = new MemoryQueryGenerator(sonnetLLMClient);
// Pass memoryService + memoryQueryGenerator to ActionExecutor
```

## Files Changed

| File | Change |
|------|--------|
| `src/memory/types.ts` | Add `MemorySearchOptions`, `MemorySearchResult`, `MemoryQueryInput` |
| `src/memory/memory-store.ts` | Add `search()` method |
| `src/memory/memory-service.ts` | Add `searchMemories()` method |
| `src/memory/query-generator.ts` | **New** — `MemoryQueryGenerator` class |
| `src/prompts/memory-query/v1.md` | **New** — placeholder for user-provided prompt |
| `src/cache/local-cache.ts` | Add `memories` to `CachedContext`, add `getMemories()` / `saveMemories()` |
| `src/cli/managers/action-executor.ts` | Add `executeRetrieveMemories()`, call before review |
| `src/cli/orchestrator.ts` | Update `review_with_context` and `run_review` paths |
| `src/cli/types.ts` | Add `hasMemories` to `WorkflowState` |
| `src/cli/managers/workflow-state-manager.ts` | Detect `hasMemories` state |
| `src/review/types.ts` | Add `memories?` to `ReviewInput` |
| `index.ts` | Wire Sonnet `LLMClient`, `MemoryQueryGenerator`, pass to `ActionExecutor` |
