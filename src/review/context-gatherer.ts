import {
	AIMessage,
	type BaseMessage,
	HumanMessage,
	type ToolCall,
	ToolMessage,
} from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { ReactAgent } from "langchain";
import type { ContextEvent, ReviewState } from "./types";

export class ContextGatherer {
	constructor(private agent: ReactAgent) {}

	public async gatherNode(
		state: ReviewState,
		config: LangGraphRunnableConfig,
	): Promise<Partial<ReviewState>> {
		const writer = this.createWriter(config);

		this.emitContextStart(writer);

		try {
			const message = this.buildContextMessage(state);
			const { context, allMessages } = await this.processAgentStream(
				state,
				message,
				writer,
			);

			this.emitSuccess(writer);
			this.emitContextData(writer, state, context);

			return {
				...state,
				context,
				messages: allMessages,
			};
		} catch (error) {
			this.emitError(writer, error as Error);
			return {
				...state,
				context: "Context gathering failed.",
			};
		}
	}

	public async *gather(
		state: ReviewState,
	): AsyncGenerator<Partial<ContextEvent | ReviewState>> {
		const writer = this.createGeneratorWriter();

		this.emitContextStart(writer);
		try {
			const message = this.buildContextMessage(state);
			const { context, allMessages } = await this.processAgentStream(
				state,
				message,
				writer,
			);

			this.emitSuccess(writer);
			this.emitContextData(writer, state, context);

			yield {
				...state,
				context,
				messages: allMessages,
			};
		} catch (error) {
			this.emitError(writer, error as Error);
			yield {
				...state,
				context: "Context gathering failed.",
			};
		}
	}

	private createWriter(
		config: LangGraphRunnableConfig,
	): (event: ContextEvent) => void {
		return (
			config.writer ||
			((_event: ContextEvent) => {
				// Silent no-op when streaming not configured
			})
		);
	}

	private createGeneratorWriter(): (event: ContextEvent) => void {
		return function* (event: ContextEvent) {
			yield event;
		};
	}

	private buildContextMessage(state: ReviewState): HumanMessage {
		return new HumanMessage(`Please analyze the following pull request details to gather relevant context for a code review.
Pull Request Title: ${state.title}
Description: ${state.description ?? "No description provided."}
Commits: ${state.commits.join("\n")}
Edited Files: ${state.editedFiles.join(", ")}`);
	}

	private async processAgentStream(
		state: ReviewState,
		message: HumanMessage,
		writer: (event: ContextEvent) => void,
	): Promise<{ context: string; allMessages: BaseMessage[] }> {
		const allMessages: BaseMessage[] = [...state.messages, message];

		const stream = await this.agent.stream({
			messages: allMessages,
		});

		for await (const chunk of stream) {
			if (chunk.messages && Array.isArray(chunk.messages)) {
				const message = chunk.messages[chunk.messages.length - 1];
				// console.debug("Received message from agent stream:", message);
				if (this.isAIMessageType(message)) {
					this.handleAIMessage(message, writer);
				}

				if (this.isToolMessageType(message)) {
					this.handleToolMessage(writer);
				}

				allMessages.push(message);
			}
		}

		const context = this.extractContext(allMessages);
		return { context, allMessages };
	}

	private isAIMessageType(message: BaseMessage): message is AIMessage {
		return AIMessage.isInstance(message);
	}

	private isToolMessageType(message: BaseMessage): message is ToolMessage {
		return ToolMessage.isInstance(message);
	}

	private handleAIMessage(
		msg: AIMessage,
		writer: (event: ContextEvent) => void,
	): void {
		if (this.hasToolCallReasoning(msg)) {
			this.emitToolCallReasoning(msg, writer);
		}

		if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
			this.emitToolCalls(msg.tool_calls, writer);
		}
	}

	private hasToolCallReasoning(msg: AIMessage): boolean {
		return (
			Array.isArray(msg.content) &&
			msg.content.map((c: { type: string }) => c.type).includes("text") &&
			msg.content.map((c: { type: string }) => c.type).includes("tool_use")
		);
	}

	private emitToolCallReasoning(
		msg: AIMessage,
		writer: (event: ContextEvent) => void,
	): void {
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
					writer({
						type: "context_tool_call_reasoning",
						message: text,
						metadata: {
							timestamp: Date.now(),
						},
					});
				}
			}
		}
	}

	private emitToolCalls(
		toolCalls: ToolCall[],
		writer: (event: ContextEvent) => void,
	): void {
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

			writer({
				type: "context_tool_call",
				toolName,
				input: argSummary,
				metadata: {
					timestamp: Date.now(),
				},
			});
		}
	}

	private handleToolMessage(writer: (event: ContextEvent) => void): void {
		writer({
			type: "context_tool_result",
			metadata: {
				timestamp: Date.now(),
			},
		});
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

	private emitContextStart(writer: (event: ContextEvent) => void): void {
		writer({
			type: "context_start",
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitSuccess(writer: (event: ContextEvent) => void): void {
		writer({
			type: "context_success",
			dataSource: "live",
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitContextData(
		writer: (event: ContextEvent) => void,
		state: ReviewState,
		context: string,
	): void {
		writer({
			type: "context_data",
			data: {
				sourceBranch: state.sourceBranch,
				targetBranch: state.targetBranch,
				currentCommit: state.sourceHash,
				context,
			},
			metadata: {
				timestamp: Date.now(),
			},
		});
	}

	private emitError(writer: (event: ContextEvent) => void, error: Error): void {
		writer({
			type: "context_error",
			message: `Context gathering failed: ${error.message}`,
			metadata: {
				timestamp: Date.now(),
			},
		});
	}
}
