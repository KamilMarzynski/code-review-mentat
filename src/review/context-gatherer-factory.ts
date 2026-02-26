import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ClientTool, ServerTool } from "@langchain/core/tools";
import { ContextGatherer } from "./context-gatherer";

/**
 * Simple factory for lazy initialization of ContextGatherer
 *
 * This allows delaying MCP tool loading until context gathering is actually needed,
 * significantly improving startup time.
 */
export class ContextGathererFactory {
	constructor(
		private model: BaseChatModel,
		private getTools: () => Promise<(ServerTool | ClientTool)[]>,
	) {}

	async create(): Promise<ContextGatherer> {
		const tools = await this.getTools();
		return ContextGatherer.create(this.model, tools);
	}
}
