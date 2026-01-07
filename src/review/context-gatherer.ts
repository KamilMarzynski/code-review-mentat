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

    this.emitContextStart(writer);

    try {
      const message = this.buildContextMessage(state);
      const { context, allMessages } = await this.processAgentStream(
        state,
        message,
        writer
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
        context: 'Context gathering failed.',
      };
    }
  }

  private createWriter(config: LangGraphRunnableConfig): (event: ContextEvent) => void {
    return config.writer || ((_event: ContextEvent) => {
      // Silent no-op when streaming not configured
    });
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
  ): Promise<{ context: string; allMessages: BaseMessage[] }> {
    const allMessages: BaseMessage[] = [...state.messages, message];

    const stream = await this.agent.stream({
      messages: allMessages,
    });

    for await (const chunk of stream) {
      if (chunk.messages && Array.isArray(chunk.messages)) {
        const currentMessage = chunk.messages[chunk.messages.length - 1];
        
        if (this.isAIMessage(currentMessage)) {
          this.handleAIMessage(currentMessage, writer);
        }

        if (this.isToolMessage(currentMessage)) {
          this.handleToolMessage(currentMessage, writer);
        }

        allMessages.push(currentMessage);
      }
    }

    const context = this.extractContext(allMessages);
    return { context, allMessages };
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

  private handleToolMessage(
    msg: any,
    writer: (event: ContextEvent) => void,
  ): void {
    writer({
      type: 'context_tool_result',
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
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitSuccess(writer: (event: ContextEvent) => void): void {
    writer({
      type: 'context_success',
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
