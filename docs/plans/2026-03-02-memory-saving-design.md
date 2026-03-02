# Memory Saving Feature Design

## Overview

Save review comment insights as searchable memories in SQLite with vector embeddings. Two LLM calls per memory (situation + lesson) via OpenRouter using a small model. Situation text is embedded locally with mxbai-embed-large for later retrieval.

## Architecture: Single MemoryService (Approach 1)

One class owns the full pipeline: LLM calls, embedding, storage. Internally composed of three focused components.

```
src/memory/
├── memory-service.ts      — Public API: MemoryService class
├── llm-client.ts          — OpenRouter fetch wrapper
├── embedder.ts            — @xenova/transformers wrapper for mxbai-embed-large
├── memory-store.ts        — SQLite + sqlite-vec operations
└── types.ts               — All memory-related types
```

Replaces `src/db/memory-storage.ts`.

## Types

```typescript
type MemoryServiceConfig = {
  dbPath: string;
  openRouterApiKey: string;
  model?: string;           // default: "anthropic/claude-haiku-4-5"
  embeddingModel?: string;  // default: "mixedbread-ai/mxbai-embed-large-v1"
};

type CreateMemoryInput = {
  file: string;
  severity: string;
  code: string;             // diff for this comment
  comment: string;
  additionalContext?: string;
  projectName?: string;     // optional, strategy TBD for monorepos/microservices
};

type MemoryDocument = {
  id: string;
  situation: string;
  lesson: string;
  fileExtension: string;
  projectName: string | null;
  file: string;
  severity: string;
  embedding: Float32Array;
  createdAt: string;
};

type CreateMemoryResult = {
  id: string;
  situation: string;
  lesson: string;
};
```

## Internal Components

### LLMClient (`llm-client.ts`)
- Thin wrapper: `complete(systemPrompt, userMessage) → string`
- Direct `fetch` to OpenRouter `/v1/chat/completions`
- No streaming, no tools — prompt in, text out

### Embedder (`embedder.ts`)
- Wraps `@xenova/transformers` pipeline for `mxbai-embed-large-v1`
- `initialize()` downloads model to `~/.cache/huggingface` on first use
- `embed(text) → Float32Array` returns normalized vector
- `getDimensions() → 1024`

### MemoryStore (`memory-store.ts`)
- `bun:sqlite` with `sqlite-vec` extension
- Two tables: `memories` (data) + `memories_vec` (vec0 virtual table)
- `initialize(dimensions)` creates tables if not exist
- `insert(doc)` writes to both tables in a transaction

### MemoryService (`memory-service.ts`)
- Composes LLMClient + Embedder + MemoryStore
- `initialize()` — init embedder + store
- `createMemory(input) → CreateMemoryResult`:
  1. Load situation prompt via `loadPrompt`, interpolate, call LLM
  2. Load lesson prompt via `loadPrompt`, interpolate (includes situation), call LLM
  3. Embed situation text
  4. Extract fileExtension from input.file
  5. Build MemoryDocument, insert into store
  6. Return `{ id, situation, lesson }`
- `close()` — cleanup

## Prompts

Two prompt files, content provided by user:
- `src/prompts/memory-situation/v1.md` — generates situation from comment data
- `src/prompts/memory-lesson/v1.md` — generates lesson from situation + comment

Variables use existing `{{variable}}` interpolation from `loadPrompt`.

Situation prompt variables: `{{file}}`, `{{severity}}`, `{{code}}`, `{{comment}}`, `{{additional_context}}`
Lesson prompt variables: `{{situation}}`, `{{comment}}`, `{{additional_context}}`

## Integration

### index.ts wiring
- Create `MemoryService` in infrastructure layer
- `await memoryService.initialize()` during startup
- Inject into `CommentResolutionManager` constructor
- `memoryService.close()` in finally block

### CommentResolutionManager changes
- New constructor param: `memoryService: MemoryService`
- `create_memory` case: prompt for additional context, call `memoryService.createMemory()`, update cache

### Cleanup
- Delete `src/db/memory-storage.ts` — fully replaced

## Dependencies

New: `@xenova/transformers` (or `@huggingface/transformers`)
Existing: `sqlite-vec`, `bun:sqlite`

## Design for extraction

The `src/memory/` module has zero dependencies on CLI, UI, or review types. It only depends on:
- `@xenova/transformers` (embedding)
- `bun:sqlite` + `sqlite-vec` (storage)
- `fetch` (LLM calls)
- `src/prompts/loader.ts` (prompt loading — would need to be bundled or made configurable)

`projectName` is optional — strategy deferred for monorepo/microservice scenarios.
