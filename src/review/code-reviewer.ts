import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { type ClaudeError, ClaudeQueryExecutor } from "./claude-query-executor";
import type { ReviewComment, ReviewEvent, ReviewState } from "./types";

type ToolUseBlock = {
	type: "tool_use";
	name: string;
	input?: Record<string, any>;
};

export class CodeReviewer {
	private executor: ClaudeQueryExecutor;

	constructor(claudePath: string) {
		this.executor = new ClaudeQueryExecutor(claudePath);
	}

	public async *review(
		state: ReviewState,
	): AsyncGenerator<ReviewEvent | ReviewState> {
		const writer = this.createGeneratorWriter();
		this.emitReviewStart(writer);

		const prompt = this.buildPrompt(state);

		// Track tools used during review for verification validation
		const toolsUsed: Array<{ tool: string; input: string }> = [];

		const result = await this.executor.executeStructured<{
			comments: ReviewComment[];
		}>({
			prompt,
			schema: this.getReviewSchema(),
			systemPromptAppend: [
				"You are in READ-ONLY review mode.",
				"Never use Edit or Write tools.",
				"Prefer Grep/Glob/Read for codebase discovery.",
				"IMPORTANT: For each comment, you MUST have used a tool to verify it.",
				"Comments without tool verification will be flagged as low confidence.",
			].join("\n"),
			allowedTools: ["Read", "Grep", "Glob"],
			disallowedTools: ["Edit", "Write"],
			permissionMode: "default",
			canUseTool: async (toolName, input) => {
				if (toolName === "Edit" || toolName === "Write") {
					return { behavior: "deny", message: "Review node is read-only." };
				}
				// Track tool usage for verification
				toolsUsed.push({
					tool: toolName,
					input:
						input?.file_path ||
						input?.path ||
						input?.pattern ||
						input?.query ||
						"",
				});
				return { behavior: "allow", updatedInput: input };
			},
			onMessage: (msg) => this.handleMessage(msg, writer),
		});

		if (!result.success) {
			this.emitClaudeError(writer, result.error);
			yield {
				...state,
				comments: [],
				result: `Review failed: ${result.error.message}`,
			};
			return;
		}

		const comments = result.data.comments;

		// Validate and annotate comments based on actual tool usage
		const validatedComments = this.validateCommentVerification(
			comments,
			toolsUsed,
		);

		this.emitSuccess(writer, validatedComments);
		this.emitReviewData(writer, state, validatedComments);

		yield {
			...state,
			comments: validatedComments,
			result: "Review completed successfully",
		};
	}

	/**
	 * Validates that comments claiming verification actually had corresponding tool calls.
	 * Downgrades confidence for unverified claims.
	 */
	private validateCommentVerification(
		comments: ReviewComment[],
		toolsUsed: Array<{ tool: string; input: string }>,
	): ReviewComment[] {
		return comments.map((comment) => {
			// Check if the file was actually read/grepped
			const fileWasVerified = toolsUsed.some(
				(t) =>
					(t.tool === "Read" || t.tool === "Grep") &&
					t.input.includes(comment.file.split("/").pop() || comment.file),
			);

			// If comment claims high confidence but file wasn't verified, downgrade
			if (comment.confidence === "high" && !fileWasVerified) {
				return {
					...comment,
					confidence: "medium" as const,
					verifiedBy: comment.verifiedBy
						? `${comment.verifiedBy} [UNVERIFIED - file not found in tool calls]`
						: "[UNVERIFIED - no tool verification found]",
				};
			}

			// If no tools were used at all and confidence is high, downgrade to low
			if (toolsUsed.length === 0 && comment.confidence === "high") {
				return {
					...comment,
					confidence: "low" as const,
					verifiedBy: "[UNVERIFIED - no tools used during review]",
				};
			}

			return comment;
		});
	}

	private createWriter(
		config: LangGraphRunnableConfig,
	): (event: ReviewEvent) => void {
		return (
			config.writer ||
			((_event: ReviewEvent) => {
				// Silent no-op when streaming not configured
			})
		);
	}

	private createGeneratorWriter(): (event: ReviewEvent) => void {
		return function* (event: ReviewEvent) {
			yield event;
		};
	}

	private buildPrompt(state: ReviewState): string {
		const contextGuidance = this.buildContextGuidance(state.context);

		return [
			"You are performing a code review for a pull request.",
			"",
			"## Review Priorities (in order)",
			"1. **CRITICAL**: Security vulnerabilities, data loss, authz/authn flaws, breaking changes, privacy leaks",
			"2. **HIGH**: Logic bugs, unsafe edge cases, race conditions, unhandled errors, backwards-incompatible behavior",
			"3. **MEDIUM**: Performance regressions, missing validation, reliability/observability gaps that could cause incidents",
			"4. **LOW**: Maintainability improvements only when they meaningfully reduce risk or future defects",

			"",
			"## Common Code Quality Issues to Check",
			"- **Error handling**: Unhandled errors, swallowed exceptions, missing cleanup",
			"- **Null/undefined safety**: Missing checks, unsafe access patterns",
			"- **Resource management**: Leaks, unclosed handles, missing cleanup",
			"- **Concurrency**: Race conditions, deadlocks, unsafe shared state",
			"- **Security**: Input validation, injection risks, unsafe operations",
			"",
			"## Scope Rules",
			"- Start from the PR diff and changed files.",
			"- Expand beyond the diff only when required to confirm impact (callers, interfaces, configs, data contracts).",
			"- If an issue is speculative or cannot be confirmed with evidence, do not report it.",
			"",
			"## Evidence & Verification (MANDATORY)",
			"You MUST use tools (Grep/Read) to verify every reported issue against the codebase.",
			"Each comment MUST include a `verifiedBy` string with:",
			"- The tool used (Grep or Read)",
			"- The exact file(s) inspected",
			"- What you found (include a short identifier such as a function name, symbol, or a short quoted fragment)",
			"Examples:",
			'- "Read src/foo/bar: saw `deleteAll()` called without guard in handler()"',
			'- "Grep `eval(`: match in src/x/y and confirmed use via Read src/x/y"',
			"If you cannot provide that level of evidence, do not emit the comment.",
			"",
			"## Confidence (strict)",
			"- high: Read confirms the issue in the specific location AND you can explain the concrete failure mode.",
			"- medium: Grep finds a risky pattern, but Read could not confirm in this context.",
			"- low: Do NOT output low-confidence comments (exclude them entirely).",
			"",
			"## Severity Guidance",
			"- risk: could lead to security/reliability/data-loss incidents",
			"- issue: likely bug or correctness problem with user-visible impact",
			"- suggestion: worthwhile improvement that reduces future defects (not cosmetic)",
			"- nit: use only when it prevents confusion or a future bug (still not style)",
			"",
			"## Anti-Patterns to Avoid",
			"- Do NOT comment on style/formatting (covered by linters)",
			"- Do NOT suggest cosmetic refactors",
			"- Do NOT repeat the same comment for multiple occurrences",
			"- Do NOT comment on naming unless it causes actual confusion",
			"- Do NOT suggest adding comments to self-explanatory code",
			"",
			"## Examples of GOOD vs BAD Comments",
			"",
			"### ✅ GOOD Comment (verified, actionable, high-value)",
			"```json",
			"{",
			'  "file": "src/api/handler.ts",',
			'  "line": 45,',
			'  "severity": "risk",',
			'  "message": "This async function catches errors but re-throws without the original stack trace",',
			'  "rationale": "When the caught error is wrapped in a new Error(), the original stack trace is lost, making debugging production issues difficult",',
			'  "confidence": "high",',
			'  "verifiedBy": "Read: confirmed error is caught at line 42 and new Error() thrown at 45"',
			"}",
			"```",
			"",
			"### ❌ BAD Comment (style-only, not verified)",
			"```json",
			"{",
			'  "file": "src/api/handler.ts",',
			'  "line": 12,',
			'  "severity": "suggestion",',
			'  "message": "Consider renaming this variable to be more descriptive",',
			'  "confidence": "medium",',
			'  "verifiedBy": ""',
			"}",
			"```",
			"Why bad: Style preference, not a bug. No verification performed.",
			"",
			"### ✅ GOOD Comment (security issue, verified)",
			"```json",
			"{",
			'  "file": "src/auth/validate.ts",',
			'  "line": 28,',
			'  "severity": "risk",',
			'  "message": "User input is passed directly to SQL query without sanitization",',
			'  "rationale": "The userId parameter from request body is concatenated into the query string, enabling SQL injection",',
			'  "confidence": "high",',
			'  "verifiedBy": "Grep: found query construction at line 28, traced userId from req.body at line 15"',
			"}",
			"```",
			"",
			contextGuidance,
			"",
			"## Inputs",
			`Edited files (${state.editedFiles.length}):`,
			...state.editedFiles.map((f) => `- ${f}`),
			"",
			"Commits:",
			...state.commits.map((c) => `- ${c}`),
			"",
			"PR diff:",
			state.diff,
		].join("\n");
	}

	private buildContextGuidance(context: string | undefined): string {
		if (!context || context === "Context gathering failed.") {
			return "";
		}

		return [
			"## Using Business Context",
			"The following Jira/Confluence context was gathered for this PR.",
			"Use it to understand:",
			"- What problem this PR is solving (check if the code actually solves it)",
			"- Acceptance criteria (verify they're met)",
			"- Related components (check for integration issues)",
			"",
			"Context:",
			context,
		].join("\n");
	}

	private handleMessage(msg: any, writer: (event: ReviewEvent) => void): void {
		if (msg.type === "assistant") {
			this.handleAssistantMessage(msg, writer);
		} else if (msg.type === "user") {
			this.handleUserMessage(msg, writer);
		}
	}

	private handleAssistantMessage(
		msg: any,
		writer: (event: ReviewEvent) => void,
	): void {
		const { content } = msg.message;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (typeof block !== "object" || block === null || !("type" in block))
				continue;

			if (block.type === "text" && "text" in block) {
				this.emitThinking(writer, block.text);
			} else if (block.type === "tool_use" && "name" in block) {
				this.emitToolCall(writer, block);
			}
		}
	}

	private handleUserMessage(
		msg: any,
		writer: (event: ReviewEvent) => void,
	): void {
		const { content } = msg.message;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (typeof block !== "object" || block === null || !("type" in block))
				continue;

			if (block.type === "tool_result") {
				this.emitToolResult(writer);
			}
		}
	}

	private emitReviewStart(writer: (event: ReviewEvent) => void): void {
		writer({
			type: "review_start",
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitThinking(
		writer: (event: ReviewEvent) => void,
		text: string,
	): void {
		const trimmed = text.trim();
		if (trimmed.length > 0) {
			writer({
				type: "review_thinking",
				text: trimmed,
				metadata: {
					timestamp: Date.now(),
				},
			});
		}
	}

	private emitToolCall(
		writer: (event: ReviewEvent) => void,
		block: ToolUseBlock,
	): void {
		const input =
			block.input?.file_path ||
			block.input?.path ||
			block.input?.pattern ||
			block.input?.query ||
			"";
		writer({
			type: "review_tool_call",
			toolName: block.name,
			input,
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitToolResult(writer: (event: ReviewEvent) => void): void {
		writer({
			type: "review_tool_result",
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitSuccess(
		writer: (event: ReviewEvent) => void,
		comments: ReviewComment[],
	): void {
		writer({
			type: "review_success",
			dataSource: "live",
			commentCount: comments.length,
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitReviewData(
		writer: (event: ReviewEvent) => void,
		state: ReviewState,
		comments: ReviewComment[],
	): void {
		writer({
			type: "review_data",
			data: {
				sourceBranch: state.sourceBranch,
				targetBranch: state.targetBranch,
				currentCommit: state.sourceHash,
				comments,
			},
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitClaudeError(
		writer: (event: ReviewEvent) => void,
		error: ClaudeError,
	): void {
		writer({
			type: "review_error",
			message: `Review failed: ${error.message}`,
			error: {
				name: error.type,
				message: error.message,
				stack: error.originalError?.stack,
			},
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private getReviewSchema(): Record<string, unknown> {
		return {
			type: "object",
			additionalProperties: false,
			properties: {
				comments: {
					type: "array",
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							file: { type: "string" },
							line: { type: "number" },
							startLine: { type: "number" },
							endLine: { type: "number" },
							severity: {
								type: "string",
								enum: ["nit", "suggestion", "issue", "risk"],
							},
							message: { type: "string" },
							rationale: { type: "string" },
							confidence: {
								type: "string",
								enum: ["high", "medium", "low"],
							},
							verifiedBy: { type: "string" },
						},
						required: ["file", "message"],
					},
				},
			},
			required: ["comments"],
		};
	}
}
