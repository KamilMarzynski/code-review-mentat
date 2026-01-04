import { query } from '@anthropic-ai/claude-agent-sdk';
import { UILogger } from '../ui/logger';
import { theme } from '../ui/theme';
import type { ReviewState, ReviewComment } from './types';

type ToolUseBlock = {
  type: 'tool_use';
  name: string;
  input?: Record<string, any>;
};

type ToolResultBlock = {
  type: 'tool_result';
  content: string | any;
};

type TextBlock = {
  type: 'text';
  text: string;
};

export class CodeReviewer {
  constructor(
    private claudePath: string,
    private ui: UILogger,
  ) {}

  async review(state: ReviewState): Promise<Partial<ReviewState>> {
    this.ui.section('Code Review Analysis');

    const prompt = [
      'You are performing a code review for a pull request.',
      '',
      '## Inputs',
      `Edited files (${state.editedFiles.length}):`,
      ...state.editedFiles.map((f) => `- ${f}`),
      '',
      'Commits:',
      ...state.commits.map((c) => `- ${c}`),
      '',
      'Deep context (Jira/Confluence):',
      JSON.stringify(state.context, null, 2),
      '',
      'PR diff:',
      state.diff,
      '',
      '## Instructions',
      '1) Prevent production issues: correctness bugs, security vulnerabilities, data loss, breaking changes.',
      '2) Ensure the change matches the requirements implied by Jira/Confluence context.',
      '3) Identify performance regressions or scalability risks introduced by the diff.',
      '4) Improve maintainability only when it reduces future risk (no cosmetic refactors).',
    ].join('\n');

    const schema = this.getReviewSchema();

    this.ui.step('Initializing Claude Code in read-only mode');

    const spinner = this.ui.spinner();
    spinner.start(theme.accent('Claude Code awakening...'));

    try {
      const q = query({
        prompt,
        options: {
          pathToClaudeCodeExecutable: this.claudePath,
          cwd: process.cwd(),
          settingSources: ['project'],
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: [
              'You are in READ-ONLY review mode.',
              'Never use Edit or Write tools.',
              'Prefer Grep/Glob/Read for codebase discovery.',
            ].join('\n'),
          },
          outputFormat: { type: 'json_schema', schema },
          allowedTools: ['Read', 'Grep', 'Glob'],
          disallowedTools: ['Edit', 'Write'],
          executable: 'node',
          permissionMode: 'default',
          canUseTool: async (toolName, input) => {
            if (toolName === 'Edit' || toolName === 'Write') {
              return { behavior: 'deny', message: 'Review node is read-only.' };
            }
            return { behavior: 'allow', updatedInput: input };
          },
        },
      });

      let finalResult: any | null = null;
      let toolUseCount = 0;

      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const { content } = msg.message;

          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block !== null && 'type' in block) {
                const typedBlock = block as TextBlock | ToolUseBlock;

                if (typedBlock.type === 'text' && 'text' in typedBlock) {
                  const text = typedBlock.text.trim();
                  if (text.length > 0 && text.length < 100) {
                    this.ui.thinking(text);
                    spinner.message(theme.dim(text.substring(0, 50) + (text.length > 50 ? '...' : '')));
                  }
                }

                if (typedBlock.type === 'tool_use' && 'name' in typedBlock) {
                  const toolBlock = typedBlock as ToolUseBlock;
                  toolUseCount++;
                  const pathOrPattern = toolBlock.input?.path || toolBlock.input?.pattern || '';

                  spinner.message(theme.accent(this.getReviewToolMessage(toolBlock.name, pathOrPattern)));
                  this.ui.toolCall(toolBlock.name, pathOrPattern);
                }
              }
            }
          }
        }

        if (msg.type === 'user') {
          const { content } = msg.message;

          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block !== null && 'type' in block) {
                const resultBlock = block as ToolResultBlock;

                if (resultBlock.type === 'tool_result') {
                  const resultText = typeof resultBlock.content === 'string'
                    ? resultBlock.content
                    : JSON.stringify(resultBlock.content);
                  const summary = resultText.substring(0, 60) + (resultText.length > 60 ? '...' : '');
                  this.ui.toolResult(summary);

                  spinner.message(theme.accent(`Analyzing results (${toolUseCount} action${toolUseCount > 1 ? 's' : ''})`));
                }
              }
            }
          }
        }

        if (msg.type === 'result') {
          finalResult = msg;
        }
      }

      if (!finalResult || finalResult.subtype !== 'success') {
        throw new Error(`Claude Code review failed: ${finalResult?.subtype ?? 'unknown'}`);
      }

      const { result } = finalResult;
      const structured = finalResult.structured_output as { comments: ReviewComment[] } | undefined;
      const comments = structured?.comments ?? [];

      spinner.stop(theme.success(`✓ Review complete: ${comments.length} observation(s)`));
      this.ui.sectionComplete(`Analysis complete using ${toolUseCount} tool(s)`);

      return {
        ...state,
        comments,
        result,
      };
    } catch (error) {
      spinner.stop(theme.error('✗ Review failed'));
      this.ui.error(`Review failed: ${(error as Error).message}`);
      return {
        ...state,
        comments: [],
        result: `Review failed: ${(error as Error).message}`,
      };
    }
  }

  private getReviewToolMessage(toolName: string, arg?: string): string {
    const messages: Record<string, string> = {
      Read: `📖 Reading ${arg || 'file'}`,
      Grep: `🔍 Searching for pattern${arg ? `: ${arg}` : ''}`,
      Glob: `📁 Finding files${arg ? `: ${arg}` : ''}`,
    };
    return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ''}`;
  }

  private getReviewSchema(): object {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        comments: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string' },
              line: { type: 'number' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
              severity: { type: 'string', enum: ['nit', 'suggestion', 'issue', 'risk'] },
              message: { type: 'string' },
              rationale: { type: 'string' },
            },
            required: ['file', 'message'],
          },
        },
      },
      required: ['comments'],
    };
  }
}
