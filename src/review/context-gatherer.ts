import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import ContextCache from '../cache/context-cache';
import { UILogger } from '../ui/logger';
import { theme } from '../ui/theme';
import type { ContextEvent, ReviewState } from './types';
import type { ReactAgent } from 'langchain';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

export class ContextGatherer {
  constructor(
    private agent: ReactAgent,
    private cache: ContextCache,
    private ui: UILogger,
  ) { }

  async gather(state: ReviewState, config: LangGraphRunnableConfig): Promise<Partial<ReviewState>> {
    const writer: (chunk: ContextEvent) => void = config.writer!; // TODO: Handle undefined writer more gracefully

    if (!state.gatherContext) {
      writer({
        type: 'context_skipped',
        message: 'Skipping context gathering as per configuration.',
      })
      this.ui.info('Skipping context gathering as per configuration.');
      return { ...state, context: 'Context gathering skipped.' };
    }

    if (!state.refreshCache) {
      const cached = this.cache.get({
        sourceBranch: state.sourceBranch,
        targetBranch: state.targetBranch,
      });

      if (cached) {
        writer({
          type: 'context_success',
          message: 'Using cached deep context.',
        });
        this.ui.success('Using cached deep context');
        return { ...state, context: cached };
      }
    }

    writer({
      type: 'context_start',
      message: 'Gathering deep context from pull request metadata.',
    });
    this.ui.section('Deep Context Gathering');

    const message = new HumanMessage(`Please analyze the following pull request details to gather relevant context for a code review.
Pull Request Title: ${state.title}
Description: ${state.description ?? 'No description provided.'}
Commits: ${state.commits.join('\n')}
Edited Files: ${state.editedFiles.join(', ')}`);

    const spinner = this.ui.spinner();
    spinner.start(theme.accent('Mentat analyzing pull request metadata'));

    try {
      let toolCallCount = 0;
      const allMessages: BaseMessage[] = [...state.messages, message];

      const stream = await this.agent.stream({
        messages: allMessages,
      });

      for await (const chunk of stream) {
        // Agent stream returns { messages: [...] } chunks
        if (chunk.messages && Array.isArray(chunk.messages)) {
          for (const msg of chunk.messages) {
            // Check for AI messages with tool calls
            if (msg._getType && msg._getType() === 'ai') {
              if (msg.content && typeof msg.content === 'string') {
                const text = msg.content.trim();

                if (text.length > 0) {
                  // Emit thinking chunks
                  writer({
                    type: 'context_thinking',
                    text, // This is a partial chunk (word/token)
                  });
                }
              }

              if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const toolCall of msg.tool_calls) {
                  toolCallCount++;
                  const toolName = toolCall.name || 'unknown';
                  const args  = toolCall.args || {};

                  const argSummary = args.query || args.issueKey || args.issue_key
                    || args.pageId || args.page_id || args.id || '';

                  writer({
                    type: 'context_tool_call',
                    toolName,
                    input: argSummary,
                  });

                  const displayMessage = this.getToolMessage(toolName, argSummary);
                  spinner.message(theme.accent(displayMessage));
                  this.ui.step(displayMessage);
                }
              }
            }

            // Check for tool results
            if (msg._getType && msg._getType() === 'tool') {
              writer({
                type: 'context_tool_result',
                summary: typeof msg.content === 'string'
                  ? msg.content
                  : 'Tool returned non-string content',
                toolCallCount,
              });
              spinner.message(theme.accent(`Processing (${toolCallCount} call${toolCallCount !== 1 ? 's' : ''})`));
            }

            allMessages.push(msg);
          }
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
      });

      spinner.stop(theme.success(`✓ Context gathered using ${toolCallCount} tool call(s)`));
      this.ui.sectionComplete('Deep context synthesis complete');

      writer({
        type: 'context_data',
        data: {
          sourceBranch: state.sourceBranch,
          targetBranch: state.targetBranch,
          currentCommit: state.sourceHash,
          context
        }
      });

      this.cache.set({
        sourceBranch: state.sourceBranch,
        targetBranch: state.targetBranch,
        currentCommit: state.sourceHash,
      }, context);

      return {
        ...state,
        context,
        messages: allMessages,
      };
    } catch (error) {
      writer({
        type: 'context_error',
        message: `Context gathering failed: ${(error as Error).message}`,
      });
      spinner.stop(theme.error('✗ Context gathering failed'));
      this.ui.error(`Context gathering failed: ${(error as Error).message}`);
      return {
        ...state,
        context: 'Context gathering failed.',
      };
    }
  }

  private getToolMessage(toolName: string, arg?: string): string {
    const messages: Record<string, string> = {
      search: `🔍 Searching Jira${arg ? `: "${arg}"` : ''}`,
      getIssue: `📋 Fetching issue${arg ? ` ${arg}` : ''}`,
      getJiraIssue: `📋 Fetching issue${arg ? ` ${arg}` : ''}`,
      searchConfluencePages: `📚 Searching Confluence${arg ? `: "${arg}"` : ''}`,
      getConfluencePage: `📄 Reading page${arg ? ` ${arg}` : ''}`,
      fetch: `📡 Fetching resource${arg ? `: ${arg}` : ''}`,
      getAccessibleAtlassianResources: `🌐 Listing accessible resources${arg ? `: ${arg}` : ''}`,
    };
    return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ''}`;
  }
}
