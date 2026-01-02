import { ChatAnthropic } from '@langchain/anthropic';
import { createAgent } from 'langchain';
import { registry } from '@langchain/langgraph/zod';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  MessagesZodMeta, START, StateGraph,
} from '@langchain/langgraph';
import * as z from 'zod';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { query } from '@anthropic-ai/claude-agent-sdk';
import ContextCache from './cache';
import { ui, theme } from './ui';

type ToolCall = {
  function?: {
    name?: string;
    arguments?: string;
  };
};

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

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const { PATH_TO_CLAUDE } = process.env;
if (!PATH_TO_CLAUDE) {
  throw new Error('PATH_TO_CLAUDE environment variable is not set.');
}

type ReviewComment = {
  file: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  severity?: 'nit' | 'suggestion' | 'issue' | 'risk';
  message: string;
  rationale?: string;
};

const client = new MultiServerMCPClient({
  useStandardContentBlocks: true,
  mcpServers: {
    atlassian: {
      transport: 'stdio',
      command: npxCmd,
      args: ['-y', 'mcp-remote', 'https://mcp.atlassian.com/v1/sse'],
      restart: { enabled: true, maxAttempts: 3, delayMs: 1000 },
      // ✅ Suppress MCP server logs
      env: {
        ...process.env,
        MCP_REMOTE_LOG_LEVEL: 'error', // Only show errors
      },
    },
  },
});

const tools = await client.getTools();

const model = new ChatAnthropic({
  model: 'claude-sonnet-4-5-20250929',
  temperature: 0,
});

const agent = createAgent({
  model,
  tools,
  systemPrompt:
    'You are an assistant capable of fetching information about pull request based on pull request history.'
    + 'You should be concrete and percise in your search. Limit the number of tool calls to avoid excessive calls. You are limitted to 5 tool calls per pull request.'
    + 'Your task is to find information about jira ticket in pull request data, commits, descritpion or title and fetch this ticket information from jira system.'
    + 'Next try to find information in confluence system about anything that migh help to do code review of this pull request.'
    + 'Do not make code review yet, just collect information using available tools.'
    + 'As a result of your research, provide a summary of found information that might help to do code review of this pull request. Do not provide information that can be easile found in pull request itself, only provide additional context information.'
    + 'Ensure that you response is suited for an AI agent to use it in code review.',
});

const reviewState = z.object({
  commits: z.array(z.string()),
  diff: z.string(),
  description: z.string().optional(),
  title: z.string(),
  editedFiles: z.array(z.string()),
  sourceBranch: z.string(),
  sourceHash: z.string(),
  targetBranch: z.string(),
  targetHash: z.string(),
  gatherContext: z.boolean().default(true),
  refreshCache: z.boolean().default(false),
  messages: z
    .array(z.custom<BaseMessage>())
    .register(registry, MessagesZodMeta),
  context: z.string().optional(),
  result: z.string().optional(),
  comments: z.array(
    z.custom<ReviewComment>(),
  ),
});

type ReviewState = z.infer<typeof reviewState>;

async function contextSearchCall(state: z.infer<typeof reviewState>) {
  const cache = new ContextCache();

  if (!state.gatherContext) {
    ui.info('Skipping context gathering as per configuration.');
    return { ...state, context: 'Context gathering skipped.' };
  }

  if (!state.refreshCache) {
    const cached = cache.get({
      sourceBranch: state.sourceBranch,
      targetBranch: state.targetBranch,
    });

    if (cached) {
      ui.success('Using cached deep context');
      return { ...state, context: cached };
    }
  }

  // Fetch new context
  ui.section('Deep Context Gathering');

  const message = new HumanMessage(`Please analyze the following pull request details to gather relevant context for a code review.
Pull Request Title: ${state.title}
Description: ${state.description ?? 'No description provided.'}
Commits: ${state.commits.join('\n')}
Edited Files: ${state.editedFiles.join(', ')}`);

  ui.step('Analyzing pull request metadata');

  // ✅ Create a dynamic spinner
  const spinner = ui.spinner();
  spinner.start(theme.accent('Mentat awakening...'));

  try {
    const contextResponse = await agent.stream({
      messages: [...state.messages, message],
    });

    let toolCallCount = 0;

    // ✅ Helper to get friendly tool names
    const getToolMessage = (toolName: string, arg?: string): string => {
      const messages: Record<string, string> = {
        'search': `🔍 Searching Jira${arg ? `: "${arg}"` : ''}`,
        'getIssue': `📋 Fetching Jira issue${arg ? ` ${arg}` : ''}`,
        'getPage': `📄 Reading Confluence page${arg ? ` ${arg}` : ''}`,
        'searchPages': `📚 Searching Confluence${arg ? `: "${arg}"` : ''}`,
        'getComments': '💬 Reading comments',
        'listProjects': '📊 Listing projects',
      };
      return messages[toolName] || `⚡ Calling ${toolName}${arg ? `: ${arg}` : ''}`;
    };

    for await (const chunk of contextResponse) {
      if (chunk.messages && Array.isArray(chunk.messages)) {
        const lastMessage = chunk.messages[chunk.messages.length - 1];

        // Log tool calls
        if (lastMessage?.additional_kwargs?.tool_calls && Array.isArray(lastMessage.additional_kwargs.tool_calls)) {
          const toolCalls = lastMessage.additional_kwargs.tool_calls as ToolCall[];
          
          for (const toolCall of toolCalls) {
            toolCallCount++;
            const toolName = toolCall.function?.name || 'unknown';
            console.debug(`Tool called: ${toolName}`);
            const args = toolCall.function?.arguments;
            
            let argSummary = '';
            try {
              const parsed = JSON.parse(args || '{}');
              argSummary = parsed.query || parsed.issue_key || parsed.page_id || '';
            } catch {
              // Ignore parse errors
            }

            // ✅ Update spinner with dynamic message
            spinner.message(theme.accent(getToolMessage(toolName, argSummary)));

            ui.toolCall(toolName, argSummary);
          }
        }

        // Log tool results
        if (lastMessage?.content) {
          const content = Array.isArray(lastMessage.content) 
            ? lastMessage.content 
            : [lastMessage.content];
          
          for (const item of content) {
            if (typeof item === 'object' && item !== null && 'type' in item) {
              const block = item as ToolResultBlock;
              if (block.type === 'tool_result') {
                const resultText = typeof block.content === 'string' 
                  ? block.content 
                  : JSON.stringify(block.content);
                
                const summary = resultText.substring(0, 60) + (resultText.length > 60 ? '...' : '');
                ui.toolResult(summary);

                // ✅ Update spinner after tool completes
                if (toolCallCount > 0) {
                  spinner.message(theme.accent(`Processing results (${toolCallCount} call${toolCallCount > 1 ? 's' : ''} made)`));
                }
              }
            }
          }
        }
      }
    }

    // ✅ Stop spinner before final processing
    spinner.message(theme.accent('Synthesizing context...'));

    // Get final response
    const finalResponse = await agent.invoke({
      messages: [...state.messages, message],
    });

    const contextMessage = finalResponse.messages[finalResponse.messages.length - 1];
    let context = contextMessage?.text || '';

    if (!context || context.trim().length === 0) {
      context = 'No additional context found.';
    }

    spinner.stop(theme.success(`✓ Context gathered using ${toolCallCount} tool call(s)`));
    ui.sectionComplete(`Deep context synthesis complete`);

    // Cache the result
    cache.set({
      sourceBranch: state.sourceBranch,
      targetBranch: state.targetBranch,
      currentCommit: state.sourceHash,
    }, context);

    return {
      ...state,
      context,
      messages: [...state.messages, message, contextMessage],
    };

  } catch (error) {
    spinner.stop(theme.error('✗ Context gathering failed'));
    ui.error(`Context gathering failed: ${(error as Error).message}`);
    return {
      ...state,
      context: 'Context gathering failed.',
    };
  }
}

async function reviewCall(state: z.infer<typeof reviewState>) {
  ui.section('Code Review Analysis');

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

  const schema = {
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

  ui.step('Initializing Claude Code in read-only mode');

  const spinner = ui.spinner();
  spinner.start(theme.accent('Claude Code awakening...'));

  const getReviewToolMessage = (toolName: string, arg?: string): string => {
    const messages: Record<string, string> = {
      Read: `📖 Reading ${arg || 'file'}`,
      Grep: `🔍 Searching for pattern${arg ? `: ${arg}` : ''}`,
      Glob: `📁 Finding files${arg ? `: ${arg}` : ''}`,
    };
    return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ''}`;
  };

  try {
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: PATH_TO_CLAUDE,
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
                  ui.thinking(text);
                  spinner.message(theme.dim(text.substring(0, 50) + (text.length > 50 ? '...' : '')));
                }
              }

              if (typedBlock.type === 'tool_use' && 'name' in typedBlock) {
                const toolBlock = typedBlock as ToolUseBlock;
                toolUseCount++;
                const pathOrPattern = toolBlock.input?.path || toolBlock.input?.pattern || '';

                spinner.message(theme.accent(getReviewToolMessage(toolBlock.name, pathOrPattern)));
                ui.toolCall(toolBlock.name, pathOrPattern);
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
                ui.toolResult(summary);

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
    ui.sectionComplete(`Analysis complete using ${toolUseCount} tool(s)`);

    return {
      ...state,
      comments,
      result,
    };
  } catch (error) {
    spinner.stop(theme.error('✗ Review failed'));
    ui.error(`Review failed: ${(error as Error).message}`);
    return {
      ...state,
      comments: [],
      result: `Review failed: ${(error as Error).message}`,
    };
  }
}
const graph = new StateGraph(reviewState)
  .addNode('contextSearchCall', contextSearchCall)
  .addNode('reviewCall', reviewCall)
  .addEdge(START, 'contextSearchCall')
  .addEdge('contextSearchCall', 'reviewCall')
  .compile();

export type ReviewInput = {
  title: string,
  diff: string,
  commits: string[],
  editedFiles: string[],
  sourceHash: string,
  sourceName: string,
  targetHash: string,
  targetName: string,
  gatherContext?: boolean,
  refreshCache?: boolean,
  description: string,
};

type ReviewOutput = Required<Omit<ReviewState, 'sourceHash' | 'targetHash' | 'gatherContext' | 'refreshCache' | 'commits' | 'diff' | 'editedFiles' | 'title' | 'description' | 'messages' | 'sourceBranch' | 'targetBranch'>>;

const startReview = async (input: ReviewInput): Promise<ReviewOutput> => {
  const {
    title,
    commits, diff, editedFiles, description, sourceName, targetName, gatherContext, refreshCache,
  } = input;

  const response = await graph.invoke({
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
};

export default startReview;
