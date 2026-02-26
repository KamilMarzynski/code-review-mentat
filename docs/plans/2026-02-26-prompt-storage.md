# Prompt Storage Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move all LLM prompts out of TypeScript service files into versioned markdown files under `src/prompts/`, with a `PromptLoader` that resolves the latest version and interpolates `{{variable}}` placeholders.

**Architecture:** Each prompt lives in its own subdirectory (`src/prompts/<name>/v1.md`, `v2.md`, …). A `createPromptLoader(baseDir)` factory (exported from `src/prompts/loader.ts`) handles version resolution, file reading, caching, and `{{placeholder}}` substitution. Services declare a static `PROMPT_CONFIG` constant and call the default `loadPrompt` export. The four existing prompts are migrated one-by-one, each with a commit.

**Tech Stack:** Bun runtime, `node:fs` (readFileSync / readdirSync), TypeScript strict, Biome linter.

---

## Task 1: Create PromptLoader with tests (TDD)

**Files:**
- Create: `src/prompts/__tests__/loader.test.ts`
- Create: `src/prompts/loader.ts`

---

**Step 1: Create the test file**

Create `src/prompts/__tests__/loader.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPromptLoader } from "../loader";

describe("PromptLoader", () => {
	let tmpDir: string;
	let loadPrompt: ReturnType<typeof createPromptLoader>;

	beforeAll(() => {
		tmpDir = mkdtempSync("/tmp/prompt-loader-test-");

		// Prompt with two versions and a variable
		mkdirSync(join(tmpDir, "test-prompt"));
		writeFileSync(join(tmpDir, "test-prompt", "v1.md"), "Hello {{name}}!");
		writeFileSync(join(tmpDir, "test-prompt", "v2.md"), "Hello v2 {{name}}!");

		// Static prompt with no variables
		mkdirSync(join(tmpDir, "static-prompt"));
		writeFileSync(join(tmpDir, "static-prompt", "v1.md"), "No variables here.");

		loadPrompt = createPromptLoader(tmpDir);
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("loads latest version (highest integer) when version is 'latest'", () => {
		const result = loadPrompt(
			{ name: "test-prompt", version: "latest" },
			{ name: "World" },
		);
		expect(result).toBe("Hello v2 World!");
	});

	test("loads a specific version when a number is given", () => {
		const result = loadPrompt({ name: "test-prompt", version: 1 }, { name: "World" });
		expect(result).toBe("Hello World!");
	});

	test("works with no variables for a static prompt", () => {
		const result = loadPrompt({ name: "static-prompt", version: "latest" });
		expect(result).toBe("No variables here.");
	});

	test("throws a descriptive error when a placeholder is not supplied", () => {
		expect(() =>
			loadPrompt({ name: "test-prompt", version: 1 }, {}),
		).toThrow("Prompt placeholder {{name}} not supplied in variables");
	});

	test("throws when the prompt directory does not exist", () => {
		expect(() =>
			loadPrompt({ name: "nonexistent", version: "latest" }),
		).toThrow("Prompt directory not found: nonexistent");
	});

	test("caches file content — re-reads return the original value", () => {
		// Load once to prime the cache
		const result1 = loadPrompt({ name: "static-prompt", version: 1 });
		// Overwrite the file on disk — cache should prevent picking up the change
		writeFileSync(join(tmpDir, "static-prompt", "v1.md"), "Modified content.");
		const result2 = loadPrompt({ name: "static-prompt", version: 1 });
		expect(result1).toBe(result2);
		expect(result2).toBe("No variables here.");
	});
});
```

---

**Step 2: Run tests — verify they fail**

```bash
cd /Users/mayk/Projects/private/code-review-cli
bun test src/prompts/__tests__/loader.test.ts
```

Expected: compile error — `../loader` does not exist.

---

**Step 3: Implement the loader**

Create `src/prompts/loader.ts`:

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptConfig = {
	name: string;
	version: number | "latest";
};

export type PromptVariables = Record<string, string>;

export function createPromptLoader(baseDir: string) {
	const cache = new Map<string, string>();

	function resolveVersion(name: string, version: number | "latest"): number {
		if (version !== "latest") return version;

		const dir = join(baseDir, name);
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			throw new Error(`Prompt directory not found: ${name}`);
		}

		const versions = files
			.map((f) => f.match(/^v(\d+)\.md$/))
			.filter((m): m is RegExpMatchArray => m !== null)
			.map((m) => parseInt(m[1], 10));

		if (versions.length === 0) {
			throw new Error(`No version files found in prompt directory: ${name}`);
		}

		return Math.max(...versions);
	}

	function interpolate(content: string, variables: PromptVariables): string {
		return content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
			if (!(key in variables)) {
				throw new Error(
					`Prompt placeholder {{${key}}} not supplied in variables`,
				);
			}
			return variables[key];
		});
	}

	return function loadPrompt(
		config: PromptConfig,
		variables: PromptVariables = {},
	): string {
		const version = resolveVersion(config.name, config.version);
		const cacheKey = `${config.name}:${version}`;

		let content = cache.get(cacheKey);
		if (content === undefined) {
			const filePath = join(baseDir, config.name, `v${version}.md`);
			content = readFileSync(filePath, "utf-8");
			cache.set(cacheKey, content);
		}

		return interpolate(content, variables);
	};
}

// Default loader — uses the prompts directory alongside this file.
// Import this in services; use createPromptLoader only in tests.
export const loadPrompt = createPromptLoader(import.meta.dir);
```

---

**Step 4: Run tests — verify they pass**

```bash
bun test src/prompts/__tests__/loader.test.ts
```

Expected: all 6 tests PASS.

---

**Step 5: Run linter**

```bash
bun biome check src/prompts/
```

Fix any warnings before continuing.

---

**Step 6: Commit**

```bash
git add src/prompts/loader.ts src/prompts/__tests__/loader.test.ts
git commit -m "feat: add PromptLoader with version resolution and placeholder interpolation"
```

---

## Task 2: Migrate context-gatherer system prompt

**Files:**
- Create: `src/prompts/context-gatherer/v1.md`
- Modify: `src/review/context-gatherer.ts` (lines 19–43 and 56–62)

The context-gatherer prompt has no runtime variables — it is a pure static system prompt.

---

**Step 1: Create the markdown file**

Create `src/prompts/context-gatherer/v1.md` by copying the content of the `SYSTEM_PROMPT` static constant from `src/review/context-gatherer.ts` lines 19–43. The file should look exactly like this (no variable comment block needed — no placeholders):

```markdown
You are a code review context specialist.

## Your Goal
Gather ONLY information that will help an AI perform code review. Focus on:
1. Business requirements from Jira tickets
2. Technical specifications from Confluence
3. Related architectural decisions

## Process
1. Extract ticket references from PR title, description, and commits (e.g., PROJ-123)
2. Fetch each ticket and summarize acceptance criteria
3. Search Confluence for related technical documentation
4. Synthesize findings into actionable context

## Output Format
Provide a structured summary:
- **Requirements**: What the PR should accomplish
- **Technical Context**: Relevant architecture/patterns
- **Edge Cases**: Known constraints or special handling

## Constraints
- Skip information already in the PR description
- Keep tool calls concise and relevant - maximum 10 calls
- Focus on REQUIREMENTS, not implementation details
```

---

**Step 2: Update context-gatherer.ts**

In `src/review/context-gatherer.ts`:

1. Remove the `private static readonly SYSTEM_PROMPT = ...` constant (lines 19–43).
2. Add import at the top of the file:
   ```typescript
   import { loadPrompt } from "../prompts/loader";
   ```
3. In the `create()` static method, replace `ContextGatherer.SYSTEM_PROMPT` with a loader call:
   ```typescript
   static create(
     model: BaseChatModel,
     tools: (ServerTool | ClientTool)[],
   ): ContextGatherer {
     const agent = createAgent({
       model,
       tools,
       systemPrompt: loadPrompt({ name: "context-gatherer", version: "latest" }),
     });
     return new ContextGatherer(agent);
   }
   ```

---

**Step 3: Run linter**

```bash
bun biome check src/review/context-gatherer.ts src/prompts/context-gatherer/
```

Fix any warnings.

---

**Step 4: Commit**

```bash
git add src/prompts/context-gatherer/v1.md src/review/context-gatherer.ts
git commit -m "feat: migrate context-gatherer system prompt to markdown"
```

---

## Task 3: Migrate code-review prompt

**Files:**
- Create: `src/prompts/code-review/v1.md`
- Modify: `src/review/code-reviewer.ts` (lines 217–348)

The code-review prompt has dynamic sections at the bottom (inputs). The static instruction body is the majority of the file. The `buildContextGuidance()` private method stays in TypeScript and its output feeds the `{{contextGuidance}}` variable.

---

**Step 1: Create the markdown file**

Create `src/prompts/code-review/v1.md`. The file is the full content of `buildPrompt()` in `src/review/code-reviewer.ts` (lines 220–329), converted to plain markdown with five placeholders replacing the dynamic parts.

Exact content:

```markdown
<!--
Variables:
  {{contextGuidance}}    - Jira/Confluence context section (empty string when no context)
  {{editedFilesCount}}   - number of changed files (e.g. "3")
  {{editedFilesList}}    - newline-separated list prefixed with "- " (e.g. "- src/foo.ts\n- src/bar.ts")
  {{commitsList}}        - newline-separated list prefixed with "- "
  {{diff}}               - raw git diff output
-->

You are performing a code review for a pull request.

## Review Priorities (in order)
1. **CRITICAL**: Security vulnerabilities, data loss, authz/authn flaws, breaking changes, privacy leaks
2. **HIGH**: Logic bugs, unsafe edge cases, race conditions, unhandled errors, backwards-incompatible behavior
3. **MEDIUM**: Performance regressions, missing validation, reliability/observability gaps that could cause incidents
4. **LOW**: Maintainability improvements only when they meaningfully reduce risk or future defects

## Common Code Quality Issues to Check
- **Error handling**: Unhandled errors, swallowed exceptions, missing cleanup
- **Null/undefined safety**: Missing checks, unsafe access patterns
- **Resource management**: Leaks, unclosed handles, missing cleanup
- **Concurrency**: Race conditions, deadlocks, unsafe shared state
- **Security**: Input validation, injection risks, unsafe operations

## Scope Rules
- Start from the PR diff and changed files.
- Expand beyond the diff only when required to confirm impact (callers, interfaces, configs, data contracts).
- If an issue is speculative or cannot be confirmed with evidence, do not report it.

## Evidence & Verification (MANDATORY)
You MUST use tools (Grep/Read) to verify every reported issue against the codebase.
Each comment MUST include a `verifiedBy` string with:
- The tool used (Grep or Read)
- The exact file(s) inspected
- What you found (include a short identifier such as a function name, symbol, or a short quoted fragment)

Examples:
- "Read src/foo/bar: saw `deleteAll()` called without guard in handler()"
- "Grep `eval(`: match in src/x/y and confirmed use via Read src/x/y"

If you cannot provide that level of evidence, do not emit the comment.

## Confidence (strict)
- high: Read confirms the issue in the specific location AND you can explain the concrete failure mode.
- medium: Grep finds a risky pattern, but Read could not confirm in this context.
- low: Do NOT output low-confidence comments (exclude them entirely).

## Severity Guidance
- risk: could lead to security/reliability/data-loss incidents
- issue: likely bug or correctness problem with user-visible impact
- suggestion: worthwhile improvement that reduces future defects (not cosmetic)
- nit: use only when it prevents confusion or a future bug (still not style)

## Anti-Patterns to Avoid
- Do NOT comment on style/formatting (covered by linters)
- Do NOT suggest cosmetic refactors
- Do NOT repeat the same comment for multiple occurrences
- Do NOT comment on naming unless it causes actual confusion
- Do NOT suggest adding comments to self-explanatory code

## Examples of GOOD vs BAD Comments

### ✅ GOOD Comment (verified, actionable, high-value)
```json
{
  "file": "src/api/handler.ts",
  "line": 45,
  "startLine": 40,
  "endLine": 50,
  "severity": "risk",
  "message": "This async function catches errors but re-throws without the original stack trace",
  "rationale": "When the caught error is wrapped in a new Error(), the original stack trace is lost, making debugging production issues difficult",
  "confidence": "high",
  "verifiedBy": "Read: confirmed error is caught at line 42 and new Error() thrown at 45"
}
```

### ❌ BAD Comment (style-only, not verified)
```json
{
  "file": "src/api/handler.ts",
  "line": 12,
  "startLine": 10,
  "endLine": 15,
  "severity": "suggestion",
  "message": "Consider renaming this variable to be more descriptive",
  "confidence": "medium",
  "verifiedBy": ""
}
```
Why bad: Style preference, not a bug. No verification performed.

### ✅ GOOD Comment (security issue, verified)
```json
{
  "file": "src/auth/validate.ts",
  "line": 28,
  "startLine": 20,
  "endLine": 30,
  "severity": "risk",
  "message": "User input is passed directly to SQL query without sanitization",
  "rationale": "The userId parameter from request body is concatenated into the query string, enabling SQL injection",
  "confidence": "high",
  "verifiedBy": "Grep: found query construction at line 28, traced userId from req.body at line 15"
}
```

{{contextGuidance}}

## Inputs
Edited files ({{editedFilesCount}}):
{{editedFilesList}}

Commits:
{{commitsList}}

PR diff:
{{diff}}
```

> **Note:** The triple-backtick code blocks inside the markdown file are literal backticks — they are part of the prompt text sent to the model, not code blocks in this plan.

---

**Step 2: Update code-reviewer.ts**

In `src/review/code-reviewer.ts`:

1. Add import at the top:
   ```typescript
   import { loadPrompt, type PromptConfig } from "../prompts/loader";
   ```

2. Add a static config constant inside the `CodeReviewer` class (after the opening brace):
   ```typescript
   private static readonly PROMPT_CONFIG: PromptConfig = {
     name: "code-review",
     version: "latest",
   };
   ```

3. Replace the entire `buildPrompt()` method body (lines 217–330) with:
   ```typescript
   private buildPrompt(input: ReviewInput): string {
     return loadPrompt(CodeReviewer.PROMPT_CONFIG, {
       contextGuidance: this.buildContextGuidance(input.context),
       editedFilesCount: String(input.editedFiles.length),
       editedFilesList: input.editedFiles.map((f) => `- ${f}`).join("\n"),
       commitsList: input.commits.map((c) => `- ${c}`).join("\n"),
       diff: input.diff,
     });
   }
   ```

   The `buildContextGuidance()` private helper method (lines 332–348) stays unchanged.

---

**Step 3: Run linter**

```bash
bun biome check src/review/code-reviewer.ts src/prompts/code-review/
```

Fix any warnings.

---

**Step 4: Commit**

```bash
git add src/prompts/code-review/v1.md src/review/code-reviewer.ts
git commit -m "feat: migrate code-review prompt to markdown"
```

---

## Task 4: Migrate fix-plan prompt

**Files:**
- Create: `src/prompts/fix-plan/v1.md`
- Modify: `src/review/comment-fixer.ts` (lines 29–82 inside `generatePlan()`)

The fix-plan prompt has conditional sections (optional line number, optional user notes, optional previous-plan feedback). These are handled by passing the entire conditional block — including its heading — as the variable value. When there is no content, the variable is an empty string; the markdown template renders cleanly.

---

**Step 1: Create the markdown file**

Create `src/prompts/fix-plan/v1.md`:

```markdown
<!--
Variables:
  {{file}}                      - file path from the review comment
  {{lineSection}}               - either "**Line:** 42" or "" (empty)
  {{issue}}                     - comment message
  {{whySection}}                - either "**Why:** <rationale>" or "" (empty)
  {{additionalContextSection}}  - either "## Additional Context\n<notes>\n" or "" (empty)
  {{previousPlanFeedbackSection}} - either "## Feedback on Previous Plan\n<feedback>\n\nPlease revise your plan based on this feedback.\n" or "" (empty)
-->

# Plan a Fix for Code Review Comment

## Comment to Fix
**File:** {{file}}
{{lineSection}}
**Issue:** {{issue}}
{{whySection}}

## SCOPE CONSTRAINTS - READ CAREFULLY

⚠️ Your fix MUST be minimal and focused:
- ONLY fix the specific issue mentioned in the comment
- Do NOT refactor unrelated code
- Do NOT add features or improvements beyond the fix
- Do NOT touch files that aren't necessary for the fix
- Prefer surgical changes over broad refactors

If the fix genuinely requires changes to multiple files, explain why.
If you're unsure, propose the SMALLEST possible fix.

{{additionalContextSection}}
{{previousPlanFeedbackSection}}
## Your Task

Create a PLAN to fix this issue. Do NOT write code yet.

Your plan should include:
1. High-level approach (1-2 sentences)
2. Step-by-step implementation steps (be specific)
3. List of files that will be affected (keep minimal)
4. Potential risks or edge cases

## Plan Quality Checklist
Before finalizing, verify your plan:
- [ ] Fixes ONLY the specific issue (not adjacent problems)
- [ ] Affects the minimum number of files
- [ ] Each step is concrete and actionable
- [ ] Risks are realistic, not theoretical

Be specific but concise.
```

---

**Step 2: Update comment-fixer.ts — generatePlan()**

In `src/review/comment-fixer.ts`:

1. Add import at the top of the file:
   ```typescript
   import { loadPrompt, type PromptConfig } from "../prompts/loader";
   ```

2. Add static config constants inside the `CommentFixer` class (after the opening brace):
   ```typescript
   private static readonly FIX_PLAN_CONFIG: PromptConfig = {
     name: "fix-plan",
     version: "latest",
   };

   private static readonly FIX_EXECUTE_CONFIG: PromptConfig = {
     name: "fix-execute",
     version: "latest",
   };
   ```

3. Replace the inline prompt array inside `generatePlan()` (lines 29–82) with a loader call. The new body of `generatePlan()` from the opening brace to the `const schema = ...` line:
   ```typescript
   async generatePlan(
     comment: ReviewComment,
     context: {
       userOptionalNotes?: string;
       previousPlanFeedback?: string;
     },
   ): Promise<FixPlan> {
     const prompt = loadPrompt(CommentFixer.FIX_PLAN_CONFIG, {
       file: comment.file,
       lineSection: comment.line ? `**Line:** ${comment.line}` : "",
       issue: comment.message,
       whySection: comment.rationale ? `**Why:** ${comment.rationale}` : "",
       additionalContextSection: context.userOptionalNotes
         ? `## Additional Context\n${context.userOptionalNotes}\n`
         : "",
       previousPlanFeedbackSection: context.previousPlanFeedback
         ? `## Feedback on Previous Plan\n${context.previousPlanFeedback}\n\nPlease revise your plan based on this feedback.\n`
         : "",
     });

     const schema = { ... };  // leave schema unchanged
   ```

---

**Step 3: Run linter**

```bash
bun biome check src/review/comment-fixer.ts src/prompts/fix-plan/
```

Fix any warnings. Do not touch `buildExecutionPrompt()` yet — that comes in Task 5.

---

**Step 4: Commit**

```bash
git add src/prompts/fix-plan/v1.md src/review/comment-fixer.ts
git commit -m "feat: migrate fix-plan prompt to markdown"
```

---

## Task 5: Migrate fix-execute prompt

**Files:**
- Create: `src/prompts/fix-execute/v1.md`
- Modify: `src/review/comment-fixer.ts` — replace `buildExecutionPrompt()` with a loader call

---

**Step 1: Create the markdown file**

Create `src/prompts/fix-execute/v1.md`:

```markdown
<!--
Variables:
  {{approach}}                - high-level approach string from the approved plan
  {{steps}}                   - numbered steps, one per line (e.g. "1. Do X\n2. Do Y")
  {{filesAffected}}           - file list prefixed with "- ", one per line
  {{risksSection}}            - either "**Risks to watch for:**\n- risk1\n- risk2\n" or "" (empty)
  {{additionalContextSection}} - either "## Additional Context\n<notes>\n" or "" (empty)
-->

# Execute Approved Fix Plan

## Your Approved Plan

**Approach:**
{{approach}}

**Steps:**
{{steps}}

**Files to modify:**
{{filesAffected}}

{{risksSection}}
{{additionalContextSection}}

## Your Task

**Execute the approved plan above.**

## Execution Rules

✅ DO:
- Follow each step in order
- Read files before editing to understand current state
- Make surgical, minimal edits
- After editing, validate your changes (run tests/linters if applicable)
- Verify your changes make sense in context

❌ DO NOT:
- Edit files not in the approved list without good reason
- Make unrelated improvements or refactors
- Continue if you're confused - stop and explain
- Change more code than necessary

## Error Handling
If something unexpected happens:
- STOP immediately
- Do NOT try to fix cascading issues beyond the scope
- Explain what went wrong

Begin implementation now.
```

---

**Step 2: Update comment-fixer.ts — replace buildExecutionPrompt()**

In `src/review/comment-fixer.ts`, in the `executePlan()` method (line 153), replace:
```typescript
const prompt = this.buildExecutionPrompt(approvedPlan, context);
```
with:
```typescript
const prompt = loadPrompt(CommentFixer.FIX_EXECUTE_CONFIG, {
  approach: approvedPlan.approach,
  steps: approvedPlan.steps.map((step, i) => `${i + 1}. ${step}`).join("\n"),
  filesAffected: approvedPlan.filesAffected.map((f) => `- ${f}`).join("\n"),
  risksSection:
    approvedPlan.potentialRisks.length > 0
      ? `**Risks to watch for:**\n${approvedPlan.potentialRisks.map((r) => `- ${r}`).join("\n")}\n`
      : "",
  additionalContextSection: context.userOptionalNotes
    ? `## Additional Context\n${context.userOptionalNotes}\n`
    : "",
});
```

Then delete the entire `buildExecutionPrompt()` private method (lines 302–360) — it is no longer needed.

---

**Step 3: Run linter**

```bash
bun biome check src/review/comment-fixer.ts src/prompts/fix-execute/
```

Fix any warnings.

---

**Step 4: Run all tests**

```bash
bun test
```

Expected: all tests pass. If tests fail, investigate before continuing.

---

**Step 5: Commit**

```bash
git add src/prompts/fix-execute/v1.md src/review/comment-fixer.ts
git commit -m "feat: migrate fix-execute prompt to markdown"
```

---

## Final check

Run the full linter across all changed files:

```bash
bun biome check src/prompts/ src/review/code-reviewer.ts src/review/context-gatherer.ts src/review/comment-fixer.ts
```

All clear — the migration is complete. The four prompts live in:

```
src/prompts/
  code-review/v1.md
  context-gatherer/v1.md
  fix-plan/v1.md
  fix-execute/v1.md
  loader.ts
  __tests__/loader.test.ts
```

To add a new prompt: create `src/prompts/<name>/v1.md`, add a `PROMPT_CONFIG` constant to the service, and call `loadPrompt()`.
