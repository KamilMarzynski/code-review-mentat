import { START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { ContextGatherer } from './context-gatherer';
import { CodeReviewer } from './code-reviewer';
import { reviewState, type NodeEvent, type ReviewInput, type ReviewOutput, type ReviewState } from './types';

export class ReviewService {
  private graph;

  constructor(
    private contextGatherer: ContextGatherer,
    private codeReviewer: CodeReviewer,
  ) {
    this.graph = this.buildGraph();
  }

  private buildGraph() {
    return new StateGraph(reviewState)
      .addNode('contextSearchCall', (state: ReviewState, config: LangGraphRunnableConfig) => this.contextGatherer.gather(state, config))
      .addNode('reviewCall', (state: ReviewState, config: LangGraphRunnableConfig) => this.codeReviewer.review(state,config))
      .addEdge(START, 'contextSearchCall')
      .addEdge('contextSearchCall', 'reviewCall')
      .compile();
  }

  async startReview(input: ReviewInput): Promise<ReviewOutput> {
    const {
      title,
      commits, diff, editedFiles, description, sourceName, targetName, gatherContext, refreshCache,
    } = input;

    const response = await this.graph.invoke({
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
    });

    return {
      comments: response.comments,
      context: response.context || '',
      result: response.result || '',
    };
  }

  async *streamReview(input: ReviewInput): AsyncGenerator<ReviewOutput | NodeEvent> {
    const {
      title,
      commits, diff, editedFiles, description, sourceName, targetName, gatherContext, refreshCache, cachedContext,
    } = input;


    const events = await this.graph.stream({
      cachedContext,
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
    }, {
      streamMode: 'custom'
    });

    for await (const event of events) {
      yield event;
    }
  }
}
