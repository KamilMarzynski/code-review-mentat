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

	public async review(
		state: ReviewState,
		config: LangGraphRunnableConfig,
	): Promise<Partial<ReviewState>> {
		const writer = this.createWriter(config);
		this.emitReviewStart(writer);

		const prompt = this.buildPrompt(state);

		const result = await this.executor.executeStructured<{
			comments: ReviewComment[];
		}>({
			prompt,
			schema: this.getReviewSchema(),
			systemPromptAppend: [
				"You are in READ-ONLY review mode.",
				"Never use Edit or Write tools.",
				"Prefer Grep/Glob/Read for codebase discovery.",
			].join("\n"),
			allowedTools: ["Read", "Grep", "Glob"],
			disallowedTools: ["Edit", "Write"],
			permissionMode: "default",
			canUseTool: async (toolName, input) => {
				if (toolName === "Edit" || toolName === "Write") {
					return { behavior: "deny", message: "Review node is read-only." };
				}
				return { behavior: "allow", updatedInput: input };
			},
			onMessage: (msg) => this.handleMessage(msg, writer),
		});

		if (!result.success) {
			this.emitClaudeError(writer, result.error);
			return {
				...state,
				comments: [],
				result: `Review failed: ${result.error.message}`,
			};
		}

		const comments = result.data.comments;
		this.emitSuccess(writer, comments);
		this.emitReviewData(writer, state, comments);

		return {
			...state,
			comments,
			result: "Review completed successfully",
		};
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

	private buildPrompt(state: ReviewState): string {
		return [
			"You are performing a code review for a pull request.",
			"",
			"## Review Priorities (in order)",
			"1. **CRITICAL**: Security vulnerabilities, data loss, breaking changes",
			"2. **HIGH**: Logic bugs, race conditions, unhandled errors",
			"3. **MEDIUM**: Performance issues, missing validation",
			"4. **LOW**: Maintainability improvements (only if high-impact)",
			"",
			"## Anti-Patterns to Avoid",
			"- Do NOT comment on style/formatting (covered by linters)",
			"- Do NOT suggest cosmetic refactors",
			"- Do NOT repeat the same comment for multiple occurrences",
			"",
			"## Before Commenting",
			"Use Grep/Read to verify your concerns against the actual codebase.",
			"Only comment if you're confident the issue exists.",
			"For each comment, provide:",
			"- High confidence: Verified with tools (Grep/Read)",
			"- Medium confidence: Based on diff analysis",
			"- Low confidence: Potential concern, needs investigation",
			"",
			"## Inputs",
			`Edited files (${state.editedFiles.length}):`,
			...state.editedFiles.map((f) => `- ${f}`),
			"",
			"Commits:",
			...state.commits.map((c) => `- ${c}`),
			"",
			"Deep context (Jira/Confluence):",
			JSON.stringify(state.context, null, 2),
			"",
			"PR diff:",
			state.diff,
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
