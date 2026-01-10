import { query } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeErrorType =
	| "billing_error"
	| "authentication_error"
	| "rate_limit_error"
	| "api_error"
	| "overloaded_error"
	| "structured_output_error"
	| "unknown_error";

export type ClaudeError = {
	type: ClaudeErrorType;
	message: string;
	originalError?: any;
};

export type ClaudeQueryResult<T = any> =
	| { success: true; data: T; messages: any[] }
	| { success: false; error: ClaudeError; messages: any[] };

type MessageHandler = (msg: any) => void | Promise<void>;
type FreeFormMessageHandler = (
	msg: any,
) => Promise<"continue" | "stop"> | "continue" | "stop";

/**
 * Wrapper around Claude Agent SDK's query() function with unified error handling.
 *
 * Handles:
 * - Billing errors ("Credit balance is too low")
 * - Authentication errors
 * - Rate limit errors
 * - Structured output failures
 * - Synthetic message filtering on errors
 */
export class ClaudeQueryExecutor {
	constructor(private claudePath: string) {}

	/**
	 * Execute a query with structured output (JSON schema).
	 * Use for CodeReviewer, CommentFixer.generatePlan, etc.
	 */
	async executeStructured<T>(config: {
		prompt: string;
		schema: object;
		systemPromptAppend?: string;
		allowedTools?: string[];
		disallowedTools?: string[];
		permissionMode?: string;
		canUseTool?: (
			toolName: string,
			input: any,
		) => Promise<
			| { behavior: "allow"; updatedInput: Record<string, unknown> }
			| {
					behavior: "deny";
					message: string;
					interrupt?: boolean;
					toolUseID?: string;
			  }
		>;
		onMessage?: MessageHandler;
	}): Promise<ClaudeQueryResult<T>> {
		const q = query({
			prompt: config.prompt,
			options: {
				pathToClaudeCodeExecutable: this.claudePath,
				cwd: process.cwd(),
				settingSources: ["project"],
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					append: config.systemPromptAppend || "",
				},
				outputFormat: {
					type: "json_schema",
					schema: config.schema as Record<string, unknown>,
				},
				allowedTools: config.allowedTools,
				disallowedTools: config.disallowedTools,
				executable: "node",
				permissionMode: (config.permissionMode as any) || "default",
				canUseTool: config.canUseTool,
			},
		});

		const messages: any[] = [];
		let errorDetected: ClaudeError | null = null;
		let finalResult: any | null = null;

		try {
			for await (const msg of q) {
				// Debug log every message
				// console.debug("Msg from claude code", JSON.stringify(msg, null, 2));

				// Detect errors early
				if (!errorDetected) {
					errorDetected = this.detectError(msg);
				}

				// Skip synthetic messages if we've detected an error
				if (errorDetected && this.isSyntheticMessage(msg)) {
					console.debug(
						"Skipping synthetic message due to error:",
						errorDetected.type,
					);
					continue;
				}

				messages.push(msg);

				// Handle result messages
				if (msg.type === "result") {
					finalResult = msg;

					// Check for structured output specific errors
					if (
						msg.subtype === "error_max_structured_output_retries" &&
						!errorDetected
					) {
						errorDetected = {
							type: "structured_output_error",
							message:
								"Claude could not produce valid output matching the schema",
							originalError: msg,
						};
					}
				}

				// Call user's message handler if provided
				if (config.onMessage) {
					await config.onMessage(msg);
				}
			}

			// If we detected an error, return it
			if (errorDetected) {
				return {
					success: false,
					error: errorDetected,
					messages,
				};
			}

			// Validate we got a successful result with structured output
			if (!finalResult || finalResult.subtype !== "success") {
				return {
					success: false,
					error: {
						type: "unknown_error",
						message: `Query failed with subtype: ${finalResult?.subtype ?? "unknown"}`,
						originalError: finalResult,
					},
					messages,
				};
			}

			if (!finalResult.structured_output) {
				return {
					success: false,
					error: {
						type: "structured_output_error",
						message: "No structured output received from Claude",
						originalError: finalResult,
					},
					messages,
				};
			}

			return {
				success: true,
				data: finalResult.structured_output as T,
				messages,
			};
		} catch (error) {
			// Handle unexpected errors
			return {
				success: false,
				error: {
					type: "unknown_error",
					message: (error as Error).message,
					originalError: error,
				},
				messages,
			};
		}
	}

	/**
	 * Execute a query in free-form agent mode (no structured output).
	 * Use for CommentFixer.executePlan where the agent works autonomously.
	 */
	async executeFreeForm(config: {
		prompt: string;
		systemPromptAppend?: string;
		allowedTools?: string[];
		disallowedTools?: string[];
		permissionMode?: string;
		onMessage: FreeFormMessageHandler;
	}): Promise<
		ClaudeQueryResult<{
			completed: boolean;
			stoppedByUser: boolean;
		}>
	> {
		const q = query({
			prompt: config.prompt,
			options: {
				pathToClaudeCodeExecutable: this.claudePath,
				cwd: process.cwd(),
				settingSources: ["project"],
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					append: config.systemPromptAppend || "",
				},
				outputFormat: undefined, // Free-form mode
				allowedTools: config.allowedTools,
				disallowedTools: config.disallowedTools,
				executable: "node",
				permissionMode: (config.permissionMode as any) || "default",
			},
		});

		const messages: any[] = [];
		let errorDetected: ClaudeError | null = null;
		let userRequestedStop = false;

		try {
			for await (const msg of q) {
				// Debug log every message
				// console.debug("Msg from claude code", JSON.stringify(msg, null, 2));

				// Detect errors early
				if (!errorDetected) {
					errorDetected = this.detectError(msg);
				}

				// Skip synthetic messages if we've detected an error
				if (errorDetected && this.isSyntheticMessage(msg)) {
					console.debug(
						"Skipping synthetic message due to error:",
						errorDetected.type,
					);
					continue;
				}

				messages.push(msg);

				// If error detected, stop processing and return error
				if (errorDetected) {
					break;
				}

				// Call user's message handler
				const decision = await config.onMessage(msg);
				if (decision === "stop") {
					userRequestedStop = true;
					break;
				}
			}

			// If we detected an error, return it
			if (errorDetected) {
				return {
					success: false,
					error: errorDetected,
					messages,
				};
			}

			return {
				success: true,
				data: {
					completed: !userRequestedStop,
					stoppedByUser: userRequestedStop,
				},
				messages,
			};
		} catch (error) {
			// Handle unexpected errors
			return {
				success: false,
				error: {
					type: "unknown_error",
					message: (error as Error).message,
					originalError: error,
				},
				messages,
			};
		}
	}

	/**
	 * Detect errors from message content.
	 * Checks for billing, auth, rate limit, and API errors.
	 */
	private detectError(msg: any): ClaudeError | null {
		// Check for explicit error field
		if (msg.error) {
			const errorType = msg.error as string;
			const errorMessage =
				msg.message?.content?.[0]?.text || msg.error || "Unknown error";

			switch (errorType) {
				case "billing_error":
					return {
						type: "billing_error",
						message: errorMessage,
						originalError: msg,
					};
				case "authentication_error":
					return {
						type: "authentication_error",
						message: errorMessage,
						originalError: msg,
					};
				case "rate_limit_error":
					return {
						type: "rate_limit_error",
						message: errorMessage,
						originalError: msg,
					};
				case "api_error":
					return {
						type: "api_error",
						message: errorMessage,
						originalError: msg,
					};
				case "overloaded_error":
					return {
						type: "overloaded_error",
						message: errorMessage,
						originalError: msg,
					};
				default:
					return {
						type: "unknown_error",
						message: errorMessage,
						originalError: msg,
					};
			}
		}

		// Check for billing error in message content
		if (msg.type === "assistant" && msg.message?.content) {
			const content = msg.message.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (
						block.type === "text" &&
						block.text?.includes("Credit balance is too low")
					) {
						return {
							type: "billing_error",
							message: "Credit balance is too low",
							originalError: msg,
						};
					}
				}
			}
		}

		return null;
	}

	/**
	 * Check if a message is synthetic (injected by SDK, not from Claude).
	 */
	private isSyntheticMessage(msg: any): boolean {
		return msg.isSynthetic === true;
	}
}
