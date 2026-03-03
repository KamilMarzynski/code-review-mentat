import {
	type PermissionMode,
	query,
	type SDKMessage,
	type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

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
	originalError?: unknown;
};

export type ClaudeQueryResult<T = unknown> =
	| { success: true; data: T; messages: SDKMessage[] }
	| { success: false; error: ClaudeError; messages: SDKMessage[] };

type MessageHandler = (msg: SDKMessage) => void | Promise<void>;
type FreeFormMessageHandler = (
	msg: SDKMessage,
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
		permissionMode?: PermissionMode;
		canUseTool?: (
			toolName: string,
			input: Record<string, unknown>,
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
				permissionMode: config.permissionMode || "default",
				canUseTool: config.canUseTool,
			},
		});

		const messages: SDKMessage[] = [];
		let errorDetected: ClaudeError | null = null;
		let finalResult: SDKResultMessage | null = null;

		try {
			for await (const msg of q) {
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
		permissionMode?: PermissionMode;
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
				permissionMode: config.permissionMode || "default",
			},
		});

		const messages: SDKMessage[] = [];
		let errorDetected: ClaudeError | null = null;
		let userRequestedStop = false;

		try {
			for await (const msg of q) {
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
	private detectError(msg: SDKMessage): ClaudeError | null {
		if (msg.type !== "assistant") {
			return null;
		}

		// Check for explicit error field
		if (msg.error) {
			const errorType = msg.error;
			const content = msg.message?.content;
			const errorMessage =
				(Array.isArray(content) &&
					content[0] &&
					"type" in content[0] &&
					content[0].type === "text" &&
					"text" in content[0] &&
					content[0].text) ||
				errorType ||
				"Unknown error";

			switch (errorType) {
				case "billing_error":
					return {
						type: "billing_error",
						message: errorMessage,
						originalError: msg,
					};
				case "authentication_failed":
					return {
						type: "authentication_error",
						message: errorMessage,
						originalError: msg,
					};
				case "rate_limit":
					return {
						type: "rate_limit_error",
						message: errorMessage,
						originalError: msg,
					};
				case "server_error":
					return {
						type: "api_error",
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
		const content = msg.message?.content;
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

		return null;
	}

	/**
	 * Check if a message is synthetic (injected by SDK, not from Claude).
	 */
	private isSyntheticMessage(msg: SDKMessage): boolean {
		return msg.type === "user" && msg.isSynthetic === true;
	}
}
