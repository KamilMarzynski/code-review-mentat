import { START, StateGraph } from '@langchain/langgraph';
import { ContextGatherer } from './context-gatherer';
import { CodeReviewer } from './code-reviewer';
import { reviewState, type ReviewInput, type ReviewOutput, type ReviewState } from './types';

export class ReviewService {
  private graph: any;

  constructor(
    private contextGatherer: ContextGatherer,
    private codeReviewer: CodeReviewer,
  ) {
    this.graph = this.buildGraph();
  }

  private buildGraph() {
    return new StateGraph(reviewState)
      .addNode('contextSearchCall', (state: ReviewState) => this.contextGatherer.gather(state))
      .addNode('reviewCall', (state: ReviewState) => this.codeReviewer.review(state))
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
}
