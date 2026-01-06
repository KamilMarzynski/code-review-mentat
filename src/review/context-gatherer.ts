import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { ContextEvent, ReviewState } from './types';
import type { ReactAgent } from 'langchain';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

export class ContextGatherer {
  constructor(
    private agent: ReactAgent,
  ) { }

  public async gather(state: ReviewState, config: LangGraphRunnableConfig): Promise<Partial<ReviewState>> {
    const writer = this.createWriter(config);

    if (!state.gatherContext) {
      return this.handleSkipped(writer, state);
    }

    if (!state.refreshCache && state.cachedContext) {
      return this.handleCached(writer, state);
    }

    this.emitContextStart(writer);

    try {
      const message = this.buildContextMessage(state);
      const { context, allMessages, toolCallCount } = await this.processAgentStream(
        state,
        message,
        writer
      );

      this.emitSuccess(writer, toolCallCount);
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
        context: 'Context gathering failed.',
      };
    }
  }

  private createWriter(config: LangGraphRunnableConfig): (event: ContextEvent) => void {
    return config.writer || ((_event: ContextEvent) => {
      // Silent no-op when streaming not configured
    });
  }

  private handleSkipped(
    writer: (event: ContextEvent) => void,
    state: ReviewState
  ): Partial<ReviewState> {
    writer({
      type: 'context_skipped',
      message: 'Skipping context gathering as per configuration.',
      metadata: {
        timestamp: Date.now(),
      },
    });

    return { ...state, context: 'Context gathering skipped.' };
  }

  private handleCached(
    writer: (event: ContextEvent) => void,
    state: ReviewState
  ): Partial<ReviewState> {
    writer({
      type: 'context_success',
      dataSource: 'cache',
      message: 'Using cached deep context.',
      metadata: {
        timestamp: Date.now(),
      },
    });

    return { ...state, context: state.cachedContext };
  }

  private buildContextMessage(state: ReviewState): HumanMessage {
    return new HumanMessage(`Please analyze the following pull request details to gather relevant context for a code review.
Pull Request Title: ${state.title}
Description: ${state.description ?? 'No description provided.'}
Commits: ${state.commits.join('\n')}
Edited Files: ${state.editedFiles.join(', ')}`);
  }

  private async processAgentStream(
    state: ReviewState,
    message: HumanMessage,
    writer: (event: ContextEvent) => void
  ): Promise<{ context: string; allMessages: BaseMessage[]; toolCallCount: number }> {
    let toolCallCount = 0;
    const allMessages: BaseMessage[] = [...state.messages, message];

    const stream = await this.agent.stream({
      messages: allMessages,
    });

    for await (const chunk of stream) {
      if (chunk.messages && Array.isArray(chunk.messages)) {
        const currentMessage = chunk.messages[chunk.messages.length - 1];
        
        if (this.isAIMessage(currentMessage)) {
          this.handleAIMessage(currentMessage, writer);
          toolCallCount += this.countToolCalls(currentMessage);
        }

        if (this.isToolMessage(currentMessage)) {
          this.handleToolMessage(currentMessage, writer, toolCallCount);
        }

        allMessages.push(currentMessage);
      }
    }

    const context = this.extractContext(allMessages);
    return { context, allMessages, toolCallCount };
  }

  private isAIMessage(message: any): boolean {
    return message && message._getType && message._getType() === 'ai';
  }

  private isToolMessage(message: any): boolean {
    return message && message._getType && message._getType() === 'tool';
  }

  private handleAIMessage(msg: any, writer: (event: ContextEvent) => void): void {
    if (this.hasToolCallReasoning(msg)) {
      this.emitToolCallReasoning(msg, writer);
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      this.emitToolCalls(msg.tool_calls, writer);
    }
  }

  private hasToolCallReasoning(msg: any): boolean {
    return Array.isArray(msg.content)
      && msg.content.map((c: { type: string }) => c.type).includes('text')
      && msg.content.map((c: { type: string }) => c.type).includes('tool_use');
  }

  private emitToolCallReasoning(msg: any, writer: (event: ContextEvent) => void): void {
    for (const contentBlock of msg.content) {
      if (contentBlock.type === 'text' && contentBlock.text) {
        const text = contentBlock.text.trim();
        if (text.length > 0) {
          writer({
            type: 'context_tool_call_reasoning',
            message: text,
            metadata: {
              timestamp: Date.now(),
            },
          });
        }
      }
    }
  }

  private emitToolCalls(toolCalls: any[], writer: (event: ContextEvent) => void): void {
    for (const toolCall of toolCalls) {
      const toolName = toolCall.name || 'unknown';
      const args = toolCall.args || {};

      const argSummary = args.query || args.issueKey || args.issue_key
        || args.pageId || args.page_id || args.id || '';

      writer({
        type: 'context_tool_call',
        toolName,
        input: argSummary,
        metadata: {
          timestamp: Date.now(),
        },
      });
    }
  }

  private countToolCalls(msg: any): number {
    return (msg.tool_calls && Array.isArray(msg.tool_calls)) ? msg.tool_calls.length : 0;
  }

  private handleToolMessage(
    msg: any,
    writer: (event: ContextEvent) => void,
    toolCallCount: number
  ): void {
    writer({
      type: 'context_tool_result',
      summary: typeof msg.content === 'string'
        ? msg.content
        : 'Tool returned non-string content',
      toolCallCount,
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private extractContext(messages: BaseMessage[]): string {
    const lastMessage = messages[messages.length - 1];
    let context = '';

    if (lastMessage && 'content' in lastMessage) {
      context = typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
    }

    if (!context || context.trim().length === 0) {
      context = 'No additional context found.';
    }

    return context;
  }

  private emitContextStart(writer: (event: ContextEvent) => void): void {
    writer({
      type: 'context_start',
      message: 'Gathering deep context from pull request metadata.',
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitSuccess(writer: (event: ContextEvent) => void, toolCallCount: number): void {
    writer({
      type: 'context_success',
      message: `Context gathered using ${toolCallCount} tool call(s).`,
      dataSource: 'live',
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitContextData(
    writer: (event: ContextEvent) => void,
    state: ReviewState,
    context: string
  ): void {
    writer({
      type: 'context_data',
      data: {
        sourceBranch: state.sourceBranch,
        targetBranch: state.targetBranch,
        currentCommit: state.sourceHash,
        context
      },
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitError(writer: (event: ContextEvent) => void, error: Error): void {
    writer({
      type: 'context_error',
      message: `Context gathering failed: ${error.message}`,
      metadata: {
        timestamp: Date.now(),
      },
    });
  }
}
