import {
	type LangGraphRunnableConfig,
	START,
	StateGraph,
} from "@langchain/langgraph";
import type { CodeReviewer } from "./code-reviewer";
import type { ContextGatherer } from "./context-gatherer";
import {
	type NodeEvent,
	type ReviewInput,
	type ReviewOutput,
	type ReviewState,
	reviewState,
} from "./types";

export class ReviewService {
	private graph;

	constructor(
		private contextGatherer: ContextGatherer,
		private codeReviewer: CodeReviewer,
	) {
		this.graph = this.buildGraph();
	}

	async *streamReview(
		input: ReviewInput,
	): AsyncGenerator<ReviewOutput | NodeEvent> {
		const {
			title,
			commits,
			diff,
			editedFiles,
			description,
			sourceName,
			targetName,
			gatherContext,
			refreshCache,
			context,
		} = input;

		const events = await this.graph.stream(
			{
				context,
				commits,
				title,
				description,
				diff,
				editedFiles,
				messages: [],
				gatherContext: gatherContext ?? true,
				refreshCache: refreshCache ?? false,
				sourceBranch: sourceName,
				targetBranch: targetName,
				sourceHash: input.sourceHash,
				targetHash: input.targetHash,
			},
			{
				streamMode: "custom",
			},
		);

		for await (const event of events) {
			yield event;
		}
	}

	private buildGraph() {
		return new StateGraph(reviewState)
			.addNode(
				"contextSearchCall",
				(state: ReviewState, config: LangGraphRunnableConfig) =>
					this.contextGatherer.gather(state, config),
			)
			.addNode(
				"reviewCall",
				(state: ReviewState, config: LangGraphRunnableConfig) =>
					this.codeReviewer.review(state, config),
			)
			.addConditionalEdges(START, this.shouldGatherContext, {
				contextSearchCall: "contextSearchCall",
				reviewCall: "reviewCall",
			})
			.addEdge("contextSearchCall", "reviewCall")
			.compile();
	}

	private shouldGatherContext(
		state: ReviewState,
	): "contextSearchCall" | "reviewCall" {
		// Skip context gathering if explicitly disabled
		if (!state.gatherContext) {
			return "reviewCall";
		}

		// Skip context gathering if we have cached context and don't need to refresh
		if (!state.refreshCache && state.context) {
			return "reviewCall";
		}

		// Otherwise, gather fresh context
		return "contextSearchCall";
	}
}
