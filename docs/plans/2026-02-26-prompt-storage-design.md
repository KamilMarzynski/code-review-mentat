# Prompt Storage Design

**Date:** 2026-02-26
**Status:** Approved

## Problem

Prompts are scattered across four service files in three different patterns (static class constant, private builder methods, inline array joins). There is no versioning, no single place to look, and the static instruction text is tangled with runtime data inside TypeScript methods — making prompts hard to read, edit, or evolve independently of the code.

## Goals

- One well-known directory for all prompts
- Prompts stored as markdown files (readable and editable without TypeScript context)
- Sequential integer versioning; newest version always loaded by default
- Template placeholders (`{{variable}}`) for runtime data — full prompt in markdown, no static text in code
- Each service declares its prompt name + version in a config constant (audit trail)
- Supports adding new prompts by dropping a new subdirectory — no central registry to update

## Directory Structure

```
src/prompts/
  code-review/
    v1.md
  context-gatherer/
    v1.md
  fix-plan/
    v1.md
  fix-execute/
    v1.md
  <new-prompt>/        ← add new prompts here
    v1.md
```

Each subdirectory name is the prompt's canonical ID. Version files are named `v{N}.md`. Adding a new prompt = create a new subdirectory with `v1.md`.

## Prompt File Format

Standard markdown with `{{variable}}` placeholders. Each file starts with a comment block documenting its variables:

```markdown
<!--
Variables:
  {{editedFilesCount}}  - number of changed files
  {{editedFilesList}}   - newline-separated list of file paths
  {{commitsList}}       - newline-separated list of commit messages
  {{diff}}              - raw git diff
  {{contextGuidance}}   - optional Jira/Confluence context section (empty string if none)
-->

You are performing a code review for a pull request.

## Review Priorities
...

## Inputs
Edited files ({{editedFilesCount}}):
{{editedFilesList}}

Commits:
{{commitsList}}

PR diff:
{{diff}}
```

## PromptLoader (`src/prompts/loader.ts`)

Single module, ~50 lines, two exports:

```ts
type PromptConfig = { name: string; version: number | 'latest' }
type PromptVariables = Record<string, string>

function loadPrompt(config: PromptConfig, variables?: PromptVariables): string
```

**Behaviour:**
- Scans `src/prompts/{name}/` for `v{N}.md` files; picks highest `N` when `version: 'latest'`
- Reads synchronously (`Bun.readFileSync` — no async overhead at call site)
- Replaces all `{{key}}` occurrences with `variables[key]`
- Throws a descriptive error if a placeholder is present in the file but not supplied in variables
- Caches file contents after first read (keyed by `name:version`) — no re-reading within a process

## Service Integration

Each service declares a static config constant and calls the loader:

```ts
// code-reviewer.ts
private static readonly PROMPT_CONFIG: PromptConfig = {
  name: 'code-review',
  version: 'latest',   // pin to e.g. 1 to lock a specific version
}

private buildPrompt(input: ReviewInput): string {
  return loadPrompt(CodeReviewer.PROMPT_CONFIG, {
    editedFilesCount: String(input.editedFiles.length),
    editedFilesList: input.editedFiles.map(f => `- ${f}`).join('\n'),
    commitsList: input.commits.map(c => `- ${c}`).join('\n'),
    diff: input.diff,
    contextGuidance: this.buildContextGuidance(input.context),
  })
}
```

```ts
// context-gatherer.ts — no variables needed, system prompt is pure static
static create(model, tools) {
  const systemPrompt = loadPrompt({ name: 'context-gatherer', version: 'latest' })
  const agent = createAgent({ model, tools, systemPrompt })
  return new ContextGatherer(agent)
}
```

## Migration Plan (files affected)

| File | Change |
|---|---|
| `src/prompts/` | New directory with 4 prompt subdirs |
| `src/prompts/loader.ts` | New — PromptLoader implementation |
| `src/review/code-reviewer.ts` | `buildPrompt()` replaced by loader call; `buildContextGuidance()` kept as helper producing the `{{contextGuidance}}` variable value |
| `src/review/context-gatherer.ts` | Remove `SYSTEM_PROMPT` static constant; load from file in `create()` |
| `src/review/comment-fixer.ts` | Both inline prompt arrays replaced by loader calls (`fix-plan`, `fix-execute`) |
| `src/review/claude-query-executor.ts` | No changes |

## Versioning Workflow

To update a prompt:
1. Copy `src/prompts/{name}/v{N}.md` to `v{N+1}.md`
2. Edit the new version
3. Services using `version: 'latest'` automatically pick it up on next run
4. Services that need the old behaviour pin `version: N` in their config

Old versions are kept in the directory — rollback = update the version number in the config constant.
