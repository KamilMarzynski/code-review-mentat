import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { ContextEvent, ReviewState } from './types';
import type { ReactAgent } from 'langchain';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

export class ContextGatherer {
  constructor(
    private agent: ReactAgent,
  ) { }

  async gather(state: ReviewState, config: LangGraphRunnableConfig): Promise<Partial<ReviewState>> {
    const writer: (chunk: ContextEvent) => void = config.writer!; // TODO: Handle undefined writer more gracefully

    if (!state.gatherContext) {
      writer({
        type: 'context_skipped',
        message: 'Skipping context gathering as per configuration.',
        metadata: {
          timestamp: Date.now(),
        },
      })
      return { ...state, context: 'Context gathering skipped.' };
    }

    if (!state.refreshCache && state.cachedContext) {
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

    writer({
      type: 'context_start',
      message: 'Gathering deep context from pull request metadata.',
      metadata: {
        timestamp: Date.now(),
      },
    });

    const message = new HumanMessage(`Please analyze the following pull request details to gather relevant context for a code review.
Pull Request Title: ${state.title}
Description: ${state.description ?? 'No description provided.'}
Commits: ${state.commits.join('\n')}
Edited Files: ${state.editedFiles.join(', ')}`);

    try {
      let toolCallCount = 0;
      const allMessages: BaseMessage[] = [...state.messages, message];

      const stream = await this.agent.stream({
        messages: allMessages,
      });

      for await (const chunk of stream) {
        // Agent stream returns { messages: [...] } chunks
        if (chunk.messages && Array.isArray(chunk.messages)) {
          const currentMessage = chunk.messages[chunk.messages.length - 1];
          const msg = currentMessage;

          if (currentMessage && currentMessage._getType && currentMessage._getType() === 'ai') {

            const isToolCallReasoning = Array.isArray(msg.content)
              && msg.content.map((c: { type: string }) => c.type).includes('text') && msg.content.map((c: { type: string }) => c.type).includes('tool_use');
            // Handle structured content (array of text/tool_use blocks)
            if (isToolCallReasoning) {
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

            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
              for (const toolCall of msg.tool_calls) {
                toolCallCount++;
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
          }

          if (msg._getType && msg._getType() === 'tool') {
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
          allMessages.push(currentMessage);
        }
      }

      // Get final context from last message
      const lastMessage = allMessages[allMessages.length - 1];
      let context = '';

      if (lastMessage && 'content' in lastMessage) {
        context = typeof lastMessage.content === 'string'
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);
      }

      if (!context || context.trim().length === 0) {
        context = 'No additional context found.';
      }

      writer({
        type: 'context_success',
        message: `Context gathered using ${toolCallCount} tool call(s).`,
        dataSource: 'live',
        metadata: {
          timestamp: Date.now(),
        },
      });

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

      return {
        ...state,
        context,
        messages: allMessages,
      };
    } catch (error) {
      writer({
        type: 'context_error',
        message: `Context gathering failed: ${(error as Error).message}`,
        metadata: {
          timestamp: Date.now(),
        },
      });
      return {
        ...state,
        context: 'Context gathering failed.',
      };
    }
  }
}
