import type {
	BetaTextBlock,
	BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { loadPrompt, type PromptConfig } from "../prompts/loader";
import { ClaudeQueryExecutor } from "./claude-query-executor";
import type { ReviewComment } from "./types";

export type FixPlan = {
	approach: string; // High-level approach
	steps: string[]; // Step-by-step plan
	filesAffected: string[]; // Files that will be modified
	potentialRisks: string[]; // What could go wrong
};

export class CommentFixer {
	private static readonly FIX_PLAN_CONFIG: PromptConfig = {
		name: "fix-plan",
		version: "latest",
	};

	private static readonly FIX_EXECUTE_CONFIG: PromptConfig = {
		name: "fix-execute",
		version: "latest",
	};

	private executor: ClaudeQueryExecutor;

	constructor(claudePath: string) {
		this.executor = new ClaudeQueryExecutor(claudePath);
	}

	// =====================================
	// PHASE 1: PLANNING (Conversational)
	// =====================================

	async generatePlan(
		comment: ReviewComment,
		context: {
			userOptionalNotes?: string;
			previousPlanFeedback?: string; // For iteration
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

		const schema = {
			type: "object",
			additionalProperties: false,
			properties: {
				approach: {
					type: "string",
					description: "High-level approach to fix the issue",
				},
				steps: {
					type: "array",
					items: { type: "string" },
					description: "Ordered list of implementation steps",
				},
				filesAffected: {
					type: "array",
					items: { type: "string" },
					description: "Files that will be modified",
				},
				potentialRisks: {
					type: "array",
					items: { type: "string" },
					description: "Risks or edge cases to consider",
				},
			},
			required: ["approach", "steps", "filesAffected", "potentialRisks"],
		};

		const result = await this.executor.executeStructured<FixPlan>({
			prompt,
			schema,
			systemPromptAppend: [
				"You are in PLANNING mode.",
				"Create a clear, actionable plan to fix the code review comment.",
				"Do NOT implement yet - just plan.",
				"Be specific about what you will change and why.",
			].join("\n"),
			allowedTools: ["Read", "Grep", "Glob", "AskUserQuestion"],
			disallowedTools: ["Edit", "Write"],
			permissionMode: "default",
		});

		if (!result.success) {
			throw new Error(`Failed to generate plan: ${result.error.message}`);
		}

		return result.data;
	}

	// =====================================
	// PHASE 2: EXECUTION (Agent)
	// =====================================

	async executePlan(
		approvedPlan: FixPlan,
		context: {
			userOptionalNotes?: string;
		},
		onProgress: (event: {
			type: "thinking" | "tool_use" | "tool_result" | "checkpoint";
			message: string;
			toolName?: string;
			toolCount?: number; // How many tools used so far
		}) => Promise<"continue" | "stop">, // ✅ User can stop execution
	): Promise<{
		success: boolean;
		filesModified: string[];
		finalThoughts: string;
		error?: string;
	}> {
		const prompt = loadPrompt(CommentFixer.FIX_EXECUTE_CONFIG, {
			approach: approvedPlan.approach,
			steps: approvedPlan.steps
				.map((step, i) => `${i + 1}. ${step}`)
				.join("\n"),
			filesAffected: approvedPlan.filesAffected.map((f) => `- ${f}`).join("\n"),
			risksSection:
				approvedPlan.potentialRisks.length > 0
					? `**Risks to watch for:**\n${approvedPlan.potentialRisks.map((r) => `- ${r}`).join("\n")}\n`
					: "",
			additionalContextSection: context.userOptionalNotes
				? `## Additional Context\n${context.userOptionalNotes}\n`
				: "",
		});

		const filesModified = new Set<string>();
		let finalThoughts = "";
		let toolCallCount = 0;

		const result = await this.executor.executeFreeForm({
			prompt,
			systemPromptAppend: [
				"You are in EXECUTION mode.",
				"Implement the approved plan by editing files.",
				"Work autonomously until complete.",
				"Validate your changes as you go.",
				"",
				"IMPORTANT: You have an approved plan. Follow it closely.",
			].join("\n"),
			allowedTools: [
				"Read",
				"Write",
				"Edit",
				"Grep",
				"Glob",
				"AskUserQuestion",
			],
			permissionMode: "acceptEdits",
			onMessage: async (msg) => {
				if (msg.type === "assistant") {
					const { content } = msg.message;

					if (Array.isArray(content)) {
						for (const block of content) {
							if (
								typeof block === "object" &&
								block !== null &&
								"type" in block
							) {
								// Text = thinking
								if (block.type === "text" && "text" in block) {
									const text = (block as BetaTextBlock).text.trim();
									if (text) {
										finalThoughts = text;
										const decision = await onProgress({
											type: "thinking",
											message: text,
											toolCount: toolCallCount,
										});
										if (decision === "stop") return "stop";
									}
								}

								// Tool use
								if (block.type === "tool_use" && "name" in block) {
									const toolBlock = block as BetaToolUseBlock;
									const toolName = toolBlock.name;
									const input = this.getToolInput(toolBlock);
									toolCallCount++;
									// Checkpoint BEFORE Edit calls - let user preview what's about to change
									if (toolName === "Edit") {
										const preEditDecision = await onProgress({
											type: "checkpoint",
											message: `About to edit: ${(input.path as string) || "file"}`,
											toolName,
											toolCount: toolCallCount,
										});
										if (preEditDecision === "stop") {
											return "stop";
										}
									}
									const decision = await onProgress({
										type: "tool_use",
										message: this.describeToolUse(toolName, input),
										toolName,
										toolCount: toolCallCount,
									});

									if (decision === "stop") {
										return "stop";
									}

									if (toolName === "Edit" && input.path) {
										filesModified.add(input.path as string);
									}

									// Checkpoint every 10 tool calls
									if (toolCallCount % 10 === 0) {
										const checkpointDecision = await onProgress({
											type: "checkpoint",
											message: `Checkpoint: ${toolCallCount} operations completed. Files modified: ${filesModified.size}`,
											toolCount: toolCallCount,
										});
										if (checkpointDecision === "stop") {
											return "stop";
										}
									}
								}
							}
						}
					}
				}

				if (msg.type === "user") {
					const { content } = msg.message;

					if (Array.isArray(content)) {
						for (const block of content) {
							if (
								typeof block === "object" &&
								block !== null &&
								"type" in block
							) {
								if ("type" in block && block.type === "tool_result") {
									const resultBlock = block as {
										type: "tool_result";
										content?: string | unknown[];
									};
									const resultText =
										typeof resultBlock.content === "string"
											? resultBlock.content
											: JSON.stringify(resultBlock.content);

									const decision = await onProgress({
										type: "tool_result",
										message: resultText.substring(0, 100),
										toolCount: toolCallCount,
									});

									if (decision === "stop") return "stop";
								}
							}
						}
					}
				}

				return "continue";
			},
		});

		if (!result.success) {
			return {
				success: false,
				filesModified: Array.from(filesModified),
				finalThoughts: "Execution failed",
				error: result.error.message,
			};
		}

		return {
			success: result.data.completed,
			filesModified: Array.from(filesModified),
			finalThoughts,
		};
	}

	private getToolInput(block: BetaToolUseBlock): Record<string, unknown> {
		return (
			typeof block.input === "object" && block.input !== null ? block.input : {}
		) as Record<string, unknown>;
	}

	private describeToolUse(
		toolName: string,
		input: Record<string, unknown>,
	): string {
		switch (toolName) {
			case "Read":
				return `Reading ${(input.path as string) || "file"}`;
			case "Edit":
				return `Editing ${(input.path as string) || "file"}`;
			case "Grep":
				return `Searching for "${(input.pattern as string) || "pattern"}"`;
			case "Glob":
				return `Finding files: ${(input.pattern as string) || "pattern"}`;
			default:
				return JSON.stringify(input);
		}
	}
}
