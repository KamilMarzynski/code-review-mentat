import type { ChatAnthropic } from "@langchain/anthropic";
import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	type ToolCall,
	ToolMessage,
} from "@langchain/core/messages";

import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { createAgent, type ReactAgent } from "langchain";
import type {
	ContextEvent,
	ContextGatherInput,
	ContextGatherOutput,
} from "./types";

export class ContextGatherer {
	private static readonly SYSTEM_PROMPT =
		`You are a code review context specialist.

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
- Focus on REQUIREMENTS, not implementation details`;

	/**
	 * Factory method that creates a {@link ContextGatherer} backed by a LangChain React agent
	 * configured with the built-in system prompt.
	 *
	 * @param model - The Anthropic chat model used by the agent to reason about and synthesize context.
	 * @param tools - The set of LangChain tools (server or client) that the agent may call while gathering context.
	 * @returns A configured {@link ContextGatherer} instance ready to gather review context.
	 */
	static create(
		model: ChatAnthropic,
		tools: (ServerTool | ClientTool)[],
	): ContextGatherer {
		const agent = createAgent({
			model,
			tools,
			systemPrompt: ContextGatherer.SYSTEM_PROMPT,
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

		const stream = await this.agent.stream({
			messages: allMessages,
		});

		for await (const chunk of stream) {
			if (chunk.messages && Array.isArray(chunk.messages)) {
				const message = chunk.messages[chunk.messages.length - 1];
				// console.debug("Received message from agent stream:", message);
				if (this.isAIMessageType(message)) {
					yield* this.handleAIMessage(message);
				}

				if (this.isToolMessageType(message)) {
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

	private isAIMessageType(message: BaseMessage): message is AIMessage {
		return AIMessage.isInstance(message);
	}

	private isToolMessageType(message: BaseMessage): message is ToolMessage {
		return ToolMessage.isInstance(message);
	}

	private *handleAIMessage(msg: AIMessage): Generator<ContextEvent> {
		if (this.hasToolCallReasoning(msg)) {
			yield* this.getToolCallReasoningEvents(msg);
		}

		if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
			yield* this.getToolCallEvents(msg.tool_calls);
		}
	}

	private hasToolCallReasoning(msg: AIMessage): boolean {
		return (
			Array.isArray(msg.content) &&
			msg.content.map((c: { type: string }) => c.type).includes("text") &&
			msg.content.map((c: { type: string }) => c.type).includes("tool_use")
		);
	}

	private *getToolCallReasoningEvents(msg: AIMessage): Generator<ContextEvent> {
		if (!Array.isArray(msg.content)) {
			return;
		}

		for (const contentBlock of msg.content) {
			if (
				typeof contentBlock !== "string" &&
				contentBlock.type === "text" &&
				"text" in contentBlock
			) {
				const text = (contentBlock.text as string).trim();
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
		let context = "";

		if (lastMessage && "content" in lastMessage) {
			context =
				typeof lastMessage.content === "string"
					? lastMessage.content
					: JSON.stringify(lastMessage.content);
		}

		if (!context || context.trim().length === 0) {
			context = "No additional context found.";
		}

		return context;
	}
}
