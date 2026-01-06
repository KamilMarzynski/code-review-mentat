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

export class CodeReviewer {
  constructor(private claudePath: string) { }

  public async review(
    state: ReviewState,
    config: LangGraphRunnableConfig
  ): Promise<Partial<ReviewState>> {
    const writer = this.createWriter(config);
    this.emitReviewStart(writer);

    try {
      const prompt = this.buildPrompt(state);
      const q = this.createQuery(prompt);
      const { finalResult } = await this.processMessages(q, writer);

      this.validateResult(finalResult);
      const comments = this.extractComments(finalResult);

      this.emitSuccess(writer, comments);
      this.emitReviewData(writer, state, comments);

      return {
        ...state,
        comments,
        result: finalResult.result,
      };
    } catch (error) {
      this.emitError(writer, error as Error);
      return {
        ...state,
        comments: [],
        result: `Review failed: ${(error as Error).message}`,
      };
    }
  }

  private createWriter(config: LangGraphRunnableConfig): (event: ReviewEvent) => void {
    return config.writer || ((_event: ReviewEvent) => {
      // Silent no-op when streaming not configured
    });
  }

  private buildPrompt(state: ReviewState): string {
    return [
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
  }

  private createQuery(prompt: string) {
    return query({
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
        outputFormat: { type: 'json_schema', schema: this.getReviewSchema() },
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
  }

  private async processMessages(
    q: AsyncGenerator<any, void>,
    writer: (event: ReviewEvent) => void
  ): Promise<{ finalResult: any; toolUseCount: number }> {
    let finalResult: any | null = null;
    let toolUseCount = 0;

    for await (const msg of q) {
      // TODO: Remove debug log
      console.debug('Msg from claude code', JSON.stringify(msg, null, 2));

      if (msg.type === 'assistant') {
        this.handleAssistantMessage(msg, writer, toolUseCount);
        toolUseCount = this.countToolUses(msg, toolUseCount);
      } else if (msg.type === 'user') {
        this.handleUserMessage(msg, writer, toolUseCount);
      } else if (msg.type === 'result') {
        finalResult = msg;
      }
    }

    return { finalResult, toolUseCount };
  }

  private handleAssistantMessage(
    msg: any,
    writer: (event: ReviewEvent) => void,
    _toolUseCount: number
  ): void {
    const { content } = msg.message;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block !== 'object' || block === null || !('type' in block)) continue;

      if (block.type === 'text' && 'text' in block) {
        this.emitThinking(writer, block.text);
      } else if (block.type === 'tool_use' && 'name' in block) {
        this.emitToolCall(writer, block);
      }
    }
  }

  private handleUserMessage(
    msg: any,
    writer: (event: ReviewEvent) => void,
    toolUseCount: number
  ): void {
    const { content } = msg.message;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (typeof block !== 'object' || block === null || !('type' in block)) continue;

      if (block.type === 'tool_result') {
        this.emitToolResult(writer, block, toolUseCount);
      }
    }
  }

  private countToolUses(msg: any, currentCount: number): number {
    const { content } = msg.message;
    if (!Array.isArray(content)) return currentCount;

    let count = currentCount;
    for (const block of content) {
      if (typeof block === 'object' && block !== null && block.type === 'tool_use') {
        count++;
      }
    }
    return count;
  }

  private validateResult(finalResult: any): void {
    if (!finalResult || finalResult.subtype !== 'success') {
      throw new Error(`Claude Code review failed: ${finalResult?.subtype ?? 'unknown'}`);
    }
  }

  private extractComments(finalResult: any): ReviewComment[] {
    const structured = finalResult.structured_output as { comments: ReviewComment[] } | undefined;
    return structured?.comments ?? [];
  }

  private emitReviewStart(writer: (event: ReviewEvent) => void): void {
    writer({
      type: 'review_start',
      message: 'Starting code review analysis',
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitThinking(writer: (event: ReviewEvent) => void, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      writer({
        type: 'review_thinking',
        text: trimmed,
        metadata: {
          timestamp: Date.now(),
        },
      });
    }
  }

  private emitToolCall(writer: (event: ReviewEvent) => void, block: ToolUseBlock): void {
    const pathOrPattern = block.input?.path || block.input?.pattern || '';
    writer({
      type: 'review_tool_call',
      toolName: block.name,
      input: pathOrPattern,
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitToolResult(
    writer: (event: ReviewEvent) => void,
    block: ToolResultBlock,
    toolCallCount: number
  ): void {
    const resultText = typeof block.content === 'string'
      ? block.content
      : JSON.stringify(block.content);

    writer({
      type: 'review_tool_result',
      summary: resultText,
      toolCallCount,
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitSuccess(writer: (event: ReviewEvent) => void, comments: ReviewComment[]): void {
    writer({
      type: 'review_success',
      dataSource: 'live',
      message: `Review complete: ${comments.length} observation(s)`,
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitReviewData(
    writer: (event: ReviewEvent) => void,
    state: ReviewState,
    comments: ReviewComment[]
  ): void {
    writer({
      type: 'review_data',
      data: {
        sourceBranch: state.sourceBranch,
        targetBranch: state.targetBranch,
        currentCommit: state.sourceHash,
        comments
      },
      metadata: {
        timestamp: Date.now(),
      },
    });
  }

  private emitError(writer: (event: ReviewEvent) => void, error: Error): void {
    writer({
      type: 'review_error',
      message: `Review failed: ${error.message}`,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
      metadata: {
        timestamp: Date.now(),
      },
    });
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
