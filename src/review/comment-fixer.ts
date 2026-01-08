import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewComment } from "./types";

export type FixPlan = {
	approach: string; // High-level approach
	steps: string[]; // Step-by-step plan
	filesAffected: string[]; // Files that will be modified
	potentialRisks: string[]; // What could go wrong
};

export class CommentFixer {
	constructor(private claudePath: string) {}

	// =====================================
	// PHASE 1: PLANNING (Conversational)
	// =====================================

	async generatePlan(
		comment: ReviewComment,
		context: {
			fullDiff: string;
			userOptionalNotes?: string;
			previousPlanFeedback?: string; // For iteration
		},
	): Promise<FixPlan> {
		const prompt = [
			"# Plan a Fix for Code Review Comment",
			"",
			"## Comment to Fix",
			`**File:** ${comment.file}`,
			comment.line ? `**Line:** ${comment.line}` : "",
			`**Issue:** ${comment.message}`,
			comment.rationale ? `**Why:** ${comment.rationale}` : "",
			"",
			"## PR Context",
			"```diff",
			context.fullDiff,
			"```",
			"",
			context.userOptionalNotes
				? ["## Additional Context", context.userOptionalNotes, ""].join("\n")
				: "",
			context.previousPlanFeedback
				? [
						"## Feedback on Previous Plan",
						context.previousPlanFeedback,
						"",
						"Please revise your plan based on this feedback.",
						"",
					].join("\n")
				: "",
			"## Your Task",
			"",
			"Create a PLAN to fix this issue. Do NOT write code yet.",
			"",
			"Your plan should include:",
			"1. High-level approach (1-2 sentences)",
			"2. Step-by-step implementation steps",
			"3. List of files that will be affected",
			"4. Potential risks or edge cases",
			"",
			"Be specific but concise.",
		]
			.filter(Boolean)
			.join("\n");

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

		const q = query({
			prompt,
			options: {
				pathToClaudeCodeExecutable: this.claudePath,
				cwd: process.cwd(),
				settingSources: ["project"],
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					append: [
						"You are in PLANNING mode.",
						"Create a clear, actionable plan to fix the code review comment.",
						"Do NOT implement yet - just plan.",
						"Be specific about what you will change and why.",
					].join("\n"),
				},
				outputFormat: { type: "json_schema", schema },
				// ✅ Read-only tools for planning
				allowedTools: ["Read", "Grep", "Glob"],
				disallowedTools: ["Edit", "Write"],
				executable: "node",
				permissionMode: "default",
			},
		});

		let result: any = null;
		for await (const msg of q) {
			if (msg.type === "result" && msg.subtype === "success") {
				result = msg;
			}
		}

		if (!result?.structured_output) {
			throw new Error("Failed to generate plan");
		}

		return result.structured_output as FixPlan;
	}

	// =====================================
	// PHASE 2: EXECUTION (Agent)
	// =====================================

	async executePlan(
		comment: ReviewComment,
		approvedPlan: FixPlan,
		context: {
			fullDiff: string;
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
		const prompt = this.buildExecutionPrompt(comment, approvedPlan, context);

		const q = query({
			prompt,
			options: {
				pathToClaudeCodeExecutable: this.claudePath,
				cwd: process.cwd(),
				settingSources: ["project"],
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					append: [
						"You are in EXECUTION mode.",
						"Implement the approved plan by editing files.",
						"Work autonomously until complete.",
						"Validate your changes as you go.",
						"",
						"IMPORTANT: You have an approved plan. Follow it closely.",
					].join("\n"),
				},
				outputFormat: undefined, // Free-form agent mode
				allowedTools: ["Read", "Edit", "Grep", "Glob"],
				disallowedTools: ["Write"],
				executable: "node",
				permissionMode: "default",
			},
		});

		const filesModified = new Set<string>();
		let finalThoughts = "";
		let toolCallCount = 0;
		let shouldStop = false;

		try {
			for await (const msg of q) {
				if (shouldStop) {
					// User requested stop - gracefully exit
					break;
				}

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
									const text = (block as any).text.trim();
									if (text) {
										finalThoughts = text;
										const decision = await onProgress({
											type: "thinking",
											message: text,
											toolCount: toolCallCount,
										});
										if (decision === "stop") shouldStop = true;
									}
								}

								// Tool use
								if (block.type === "tool_use" && "name" in block) {
									const toolBlock = block as any;
									const toolName = toolBlock.name;
									toolCallCount++;

									const decision = await onProgress({
										type: "tool_use",
										message: this.describeToolUse(toolName, toolBlock.input),
										toolName,
										toolCount: toolCallCount,
									});

									if (decision === "stop") shouldStop = true;

									if (toolName === "Edit" && toolBlock.input?.path) {
										filesModified.add(toolBlock.input.path);
									}

									// ✅ Checkpoint every 5 tool calls
									if (toolCallCount % 5 === 0) {
										const checkpointDecision = await onProgress({
											type: "checkpoint",
											message: `Checkpoint: ${toolCallCount} operations completed`,
											toolCount: toolCallCount,
										});
										if (checkpointDecision === "stop") shouldStop = true;
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
								if ((block as any).type === "tool_result") {
									const resultBlock = block as any;
									const resultText =
										typeof resultBlock.content === "string"
											? resultBlock.content
											: JSON.stringify(resultBlock.content);

									const decision = await onProgress({
										type: "tool_result",
										message: resultText.substring(0, 100),
										toolCount: toolCallCount,
									});

									if (decision === "stop") shouldStop = true;
								}
							}
						}
					}
				}
			}

			return {
				success: !shouldStop,
				filesModified: Array.from(filesModified),
				finalThoughts,
			};
		} catch (error) {
			return {
				success: false,
				filesModified: Array.from(filesModified),
				finalThoughts: "Execution failed",
				error: (error as Error).message,
			};
		}
	}

	private buildExecutionPrompt(
		comment: ReviewComment,
		plan: FixPlan,
		context: {
			fullDiff: string;
			userOptionalNotes?: string;
		},
	): string {
		return [
			"# Execute Approved Fix Plan",
			"",
			"## Original Comment",
			`**File:** ${comment.file}`,
			comment.line ? `**Line:** ${comment.line}` : "",
			`**Issue:** ${comment.message}`,
			"",
			"## Your Approved Plan",
			"",
			"**Approach:**",
			plan.approach,
			"",
			"**Steps:**",
			...plan.steps.map((step, i) => `${i + 1}. ${step}`),
			"",
			"**Files to modify:**",
			...plan.filesAffected.map((f) => `- ${f}`),
			"",
			plan.potentialRisks.length > 0
				? [
						"**Risks to watch for:**",
						...plan.potentialRisks.map((r) => `- ${r}`),
						"",
					].join("\n")
				: "",
			"## PR Context",
			"```diff",
			context.fullDiff,
			"```",
			"",
			context.userOptionalNotes
				? ["## Additional Context", context.userOptionalNotes, ""].join("\n")
				: "",
			"## Your Task",
			"",
			"**Execute the approved plan above.**",
			"",
			"Work autonomously:",
			"- Follow each step in order",
			"- Read files as needed",
			"- Make edits to implement the fix",
			"- Validate your changes",
			"- Fix any issues that arise",
			"",
			"Implement the plan completely. Start now.",
		]
			.filter(Boolean)
			.join("\n");
	}

	private describeToolUse(toolName: string, input: any): string {
		switch (toolName) {
			case "Read":
				return `Reading ${input.path || "file"}`;
			case "Edit":
				return `Editing ${input.path || "file"}`;
			case "Grep":
				return `Searching for "${input.pattern || "pattern"}"`;
			case "Glob":
				return `Finding files: ${input.pattern || "pattern"}`;
			default:
				return JSON.stringify(input);
		}
	}
}
