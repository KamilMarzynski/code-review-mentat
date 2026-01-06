import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ReviewState, ReviewComment, ReviewEvent } from './types';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

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
  constructor(private claudePath: string) { }

  async review(
    state: ReviewState,
    config: LangGraphRunnableConfig
  ): Promise<Partial<ReviewState>> {
    const writer: (chunk: ReviewEvent) => void = config.writer!; // TODO: Handle undefined writer more gracefully

    writer({
      type: 'review_start',
      message: 'Starting code review analysis',
      metadata: {
        // fileCount: state.editedFiles.length,
        // commitCount: state.commits.length,
        timestamp: Date.now(),
      },
    });

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
      // const lastToolName = '';

      for await (const msg of q) {
        if (msg.type === 'assistant') {
          const { content } = msg.message;

          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block !== null && 'type' in block) {
                const typedBlock = block as TextBlock | ToolUseBlock;

                // Handle thinking text
                if (typedBlock.type === 'text' && 'text' in typedBlock) {
                  const text = typedBlock.text.trim();
                  if (text.length > 0) {
                    writer({
                      type: 'review_thinking',
                      text,
                      metadata: {
                        timestamp: Date.now(),
                      },
                    });
                  }
                }

                // Handle tool calls
                if (typedBlock.type === 'tool_use' && 'name' in typedBlock) {
                  const toolBlock = typedBlock as ToolUseBlock;
                  toolUseCount++;
                  // lastToolName = toolBlock.name;
                  console.log('Tool block:', JSON.stringify(toolBlock, null, 2));
                  const pathOrPattern = toolBlock.input?.path || toolBlock.input?.pattern || '';

                  writer({
                    type: 'review_tool_call',
                    toolName: toolBlock.name,
                    input: pathOrPattern,
                    // input: {
                    //   summary: pathOrPattern,
                    //   raw: toolBlock.input || {},
                    // },
                    metadata: {
                      // toolIndex: toolUseCount,
                      timestamp: Date.now(),
                    },
                  });
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

                  writer({
                    type: 'review_tool_result',
                    summary: resultText,
                    toolCallCount: toolUseCount,
                    // toolName: lastToolName,
                    // result: resultText,
                    metadata: {
                      // currentToolCount: toolUseCount,
                      // length: resultText.length,
                      timestamp: Date.now(),
                    },
                  });
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

      writer({
        type: 'review_success',
        dataSource: 'live',
        message: `Review complete: ${comments.length} observation(s)`,
        metadata: {
          // commentCount: comments.length,
          // toolCount: toolUseCount,
          timestamp: Date.now(),
        },
      });

      return {
        ...state,
        comments,
        result,
      };
    } catch (error) {
      writer({
        type: 'review_error',
        message: `Review failed: ${(error as Error).message}`,
        error: {
          name: (error as Error).name,
          message: (error as Error).message,
          stack: (error as Error).stack,
        },
        metadata: {
          timestamp: Date.now(),
        },
      });

      return {
        ...state,
        comments: [],
        result: `Review failed: ${(error as Error).message}`,
      };
    }
  }

  private getReviewSchema(): Record<string, unknown> {
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
