import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	type ToolCall,
	ToolMessage,
} from "@langchain/core/messages";

import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { createAgent, type ReactAgent } from "langchain";
import { loadPrompt } from "../prompts/loader";
import type {
	ContextEvent,
	ContextGatherInput,
	ContextGatherOutput,
} from "./types";

export class ContextGatherer {
	/**
	 * Factory method that creates a {@link ContextGatherer} backed by a LangChain React agent
	 * configured with the built-in system prompt.
	 *
	 * @param model - The chat model used by the agent to reason about and synthesize context.
	 * @param tools - The set of LangChain tools (server or client) that the agent may call while gathering context.
	 * @returns A configured {@link ContextGatherer} instance ready to gather review context.
	 */
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

	constructor(private agent: ReactAgent) {}

	public async *gather(
		input: ContextGatherInput,
	): AsyncGenerator<Partial<ContextEvent | ContextGatherOutput>> {
		yield {
			type: "context_start",
			metadata: {
				timestamp: Date.now(),
			},
		};

		try {
			const message = this.buildContextMessage(input);
			let context = "";
			let allMessages: BaseMessage[] = [];

			for await (const item of this.processAgentStream(message)) {
				if ("context" in item) {
					context = item.context;
					allMessages = item.allMessages;
				} else {
					yield item;
				}
			}

			yield {
				type: "context_success",
				dataSource: "live",
				metadata: {
					timestamp: Date.now(),
				},
			};

			yield {
				type: "context_data",
				data: {
					sourceBranch: input.sourceBranch,
					targetBranch: input.targetBranch,
					currentCommit: input.sourceHash,
					context,
				},
				metadata: {
					timestamp: Date.now(),
				},
			};

			yield {
				...input,
				context,
				messages: allMessages,
			};
		} catch (error) {
			yield {
				type: "context_error",
				message: `Context gathering failed: ${(error as Error).message}`,
				metadata: {
					timestamp: Date.now(),
				},
			};

			yield {
				...input,
				context: "Context gathering failed.",
				messages: [],
			};
		}
	}

	private buildContextMessage(input: ContextGatherInput): HumanMessage {
		return new HumanMessage(`Please analyze the following pull request details to gather relevant context for a code review.
Pull Request Title: ${input.title}
Description: ${input.description ?? "No description provided."}
Commits: ${input.commits.join("\n")}
Edited Files: ${input.editedFiles.join(", ")}`);
	}

	private async *processAgentStream(
		message: HumanMessage,
	): AsyncGenerator<
		ContextEvent | { context: string; allMessages: BaseMessage[] }
	> {
		const allMessages: BaseMessage[] = [message];

		const stream = await this.agent.stream(
			{
				messages: allMessages,
			},
			{ streamMode: "updates" },
		);

		for await (const chunk of stream) {
			const [_, content] = Object.entries(chunk)[0] as any;
			if (content.messages && Array.isArray(content.messages)) {
				const raw = content.messages[content.messages.length - 1];
				const message = this.deserializeMessage(raw);

				if (!message) continue;

				if (AIMessage.isInstance(message)) {
					yield* this.handleAIMessage(message);
				}

				if (ToolMessage.isInstance(message)) {
					yield {
						type: "context_tool_result",
						metadata: {
							timestamp: Date.now(),
						},
					};
				}

				allMessages.push(message);
			}
		}

		const context = this.extractContext(allMessages);
		yield { context, allMessages };
	}

	/**
	 * Deserializes a message from the LangChain serialized wire format
	 * (`{ lc: 1, type: "constructor", id: [...], kwargs: {...} }`) into a
	 * proper LangChain message instance.
	 *
	 * OpenRouter streams messages in this serialized format rather than as
	 * class instances, which breaks `AIMessage.isInstance()` checks.
	 */
	private deserializeMessage(message: unknown): BaseMessage | null {
		if (AIMessage.isInstance(message) || ToolMessage.isInstance(message)) {
			return message as BaseMessage;
		}

		const serialized = message as {
			lc?: number;
			type?: string;
			id?: string[];
			kwargs?: Record<string, unknown>;
		};

		if (
			serialized?.lc === 1 &&
			serialized?.type === "constructor" &&
			Array.isArray(serialized?.id) &&
			serialized.id.length > 0 &&
			serialized?.kwargs
		) {
			const lastId = serialized.id[serialized.id.length - 1];
			const kwargs = serialized.kwargs;

			if (lastId === "AIMessage" || lastId === "AIMessageChunk") {
				return new AIMessage({
					content: (kwargs.content as string) ?? "",
					tool_calls: (kwargs.tool_calls as ToolCall[]) ?? [],
					additional_kwargs:
						(kwargs.additional_kwargs as Record<string, unknown>) ?? {},
					usage_metadata: kwargs.usage_metadata as
						| AIMessage["usage_metadata"]
						| undefined,
					id: kwargs.id as string | undefined,
				});
			}

			if (lastId === "ToolMessage") {
				return new ToolMessage({
					content: (kwargs.content as string) ?? "",
					tool_call_id: (kwargs.tool_call_id as string) ?? "",
					name: kwargs.name as string | undefined,
				});
			}
		}

		return null;
	}

	private *handleAIMessage(msg: AIMessage): Generator<ContextEvent> {
		if (this.hasToolCallReasoning(msg)) {
			yield* this.getToolCallReasoningEvents(msg);
		}

		if (msg.tool_calls.length > 0) {
			yield* this.getToolCallEvents(msg.tool_calls);
		}
	}

	private hasToolCallReasoning(msg: AIMessage): boolean {
		return (
			Array.isArray(msg.content) &&
			msg.content.some((c: { type: string }) => c.type === "text") &&
			msg.content.some((c: { type: string }) => c.type === "tool_use")
		);
	}

	private *getToolCallReasoningEvents(msg: AIMessage): Generator<ContextEvent> {
		for (const contentBlock of msg.content as {
			type: string;
			text?: string;
		}[]) {
			if (contentBlock.type === "text" && contentBlock.text) {
				const text = contentBlock.text.trim();
				if (text.length > 0) {
					yield {
						type: "context_tool_call_reasoning",
						message: text,
						metadata: {
							timestamp: Date.now(),
						},
					};
				}
			}
		}
	}

	private *getToolCallEvents(toolCalls: ToolCall[]): Generator<ContextEvent> {
		for (const toolCall of toolCalls) {
			const toolName = toolCall.name || "unknown";
			const args = toolCall.args || {};

			const argSummary =
				args.query ||
				args.issueKey ||
				args.issue_key ||
				args.issueIdOrKey ||
				args.pageId ||
				args.page_id ||
				args.id ||
				args.jql ||
				args.cql ||
				args.cloudId ||
				"";

			yield {
				type: "context_tool_call",
				toolName,
				input: argSummary,
				metadata: {
					timestamp: Date.now(),
				},
			};
		}
	}

	private extractContext(messages: BaseMessage[]): string {
		const lastMessage = messages[messages.length - 1];
		const raw =
			lastMessage && "content" in lastMessage
				? typeof lastMessage.content === "string"
					? lastMessage.content
					: JSON.stringify(lastMessage.content)
				: "";
		return raw.trim() || "No additional context found.";
	}
}
