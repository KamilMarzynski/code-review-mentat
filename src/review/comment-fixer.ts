import { ClaudeQueryExecutor } from "./claude-query-executor";
import type { ReviewComment } from "./types";

export type FixPlan = {
	approach: string; // High-level approach
	steps: string[]; // Step-by-step plan
	filesAffected: string[]; // Files that will be modified
	potentialRisks: string[]; // What could go wrong
};

export class CommentFixer {
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
		const prompt = [
			"# Plan a Fix for Code Review Comment",
			"",
			"## Comment to Fix",
			`**File:** ${comment.file}`,
			comment.line ? `**Line:** ${comment.line}` : "",
			`**Issue:** ${comment.message}`,
			comment.rationale ? `**Why:** ${comment.rationale}` : "",
			"",
			"## SCOPE CONSTRAINTS - READ CAREFULLY",
			"",
			"⚠️ Your fix MUST be minimal and focused:",
			"- ONLY fix the specific issue mentioned in the comment",
			"- Do NOT refactor unrelated code",
			"- Do NOT add features or improvements beyond the fix",
			"- Do NOT touch files that aren't necessary for the fix",
			"- Prefer surgical changes over broad refactors",
			"",
			"If the fix genuinely requires changes to multiple files, explain why.",
			"If you're unsure, propose the SMALLEST possible fix.",
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
			"2. Step-by-step implementation steps (be specific)",
			"3. List of files that will be affected (keep minimal)",
			"4. Potential risks or edge cases",
			"",
			"## Plan Quality Checklist",
			"Before finalizing, verify your plan:",
			"- [ ] Fixes ONLY the specific issue (not adjacent problems)",
			"- [ ] Affects the minimum number of files",
			"- [ ] Each step is concrete and actionable",
			"- [ ] Risks are realistic, not theoretical",
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
		const prompt = this.buildExecutionPrompt(approvedPlan, context);

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
									const text = (block as any).text.trim();
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
									const toolBlock = block as any;
									const toolName = toolBlock.name;
									toolCallCount++;
									// ✅ Checkpoint BEFORE Edit calls - let user preview what's about to change
									if (toolName === "Edit") {
										const preEditDecision = await onProgress({
											type: "checkpoint",
											message: `About to edit: ${toolBlock.input?.path || "file"}`,
											toolName,
											toolCount: toolCallCount,
										});
										if (preEditDecision === "stop") {
											return "stop";
										}
									}
									const decision = await onProgress({
										type: "tool_use",
										message: this.describeToolUse(toolName, toolBlock.input),
										toolName,
										toolCount: toolCallCount,
									});

									if (decision === "stop") {
										return "stop";
									}

									if (toolName === "Edit" && toolBlock.input?.path) {
										filesModified.add(toolBlock.input.path);
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

	private buildExecutionPrompt(
		plan: FixPlan,
		context: {
			userOptionalNotes?: string;
		},
	): string {
		return [
			"# Execute Approved Fix Plan",
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
			context.userOptionalNotes
				? ["## Additional Context", context.userOptionalNotes, ""].join("\n")
				: "",
			"## Your Task",
			"",
			"**Execute the approved plan above.**",
			"",
			"## Execution Rules",
			"",
			"✅ DO:",
			"- Follow each step in order",
			"- Read files before editing to understand current state",
			"- Make surgical, minimal edits",
			"- After editing, validate your changes (run tests/linters if applicable)",
			"- Verify your changes make sense in context",
			"",
			"❌ DO NOT:",
			"- Edit files not in the approved list without good reason",
			"- Make unrelated improvements or refactors",
			"- Continue if you're confused - stop and explain",
			"- Change more code than necessary",
			"",
			"## Error Handling",
			"If something unexpected happens:",
			"- STOP immediately",
			"- Do NOT try to fix cascading issues beyond the scope",
			"- Explain what went wrong",
			"",
			"Begin implementation now.",
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
