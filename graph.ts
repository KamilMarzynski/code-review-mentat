import { ChatAnthropic } from '@langchain/anthropic';
import { createAgent, toolCallLimitMiddleware } from 'langchain';
import { registry } from '@langchain/langgraph/zod';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  MessagesZodMeta, START, StateGraph,
} from '@langchain/langgraph';
import * as z from 'zod';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import { query } from '@anthropic-ai/claude-agent-sdk';

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

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
    'You are an assistant capable of fetching information about merge reqeust based on merge request history.'
    + 'You should be concrete and percise in your search. Limit the number of tool calls to avoid excessive calls. You are limitted to 5 tool calls per merge request.'
    + 'Your task is to find information about jira ticket in merge request data, commits, descritpion or title and fetch this ticket information from jira system.'
    + 'Next try to find information in confluence system about anything that migh help to do code review of this merge request.'
    + 'Do not make code review yet, just collect information using available tools.'
    + 'As a result of your research, provide a summary of found information that might help to do code review of this merge request. Do not provide information that can be easile found in merge request itself, only provide additional context information.'
    + 'Ensure that you response is suited for an AI agent to use it in code review.',
});

const reviewState = z.object({
  commits: z.array(z.string()),
  diff: z.string(),
  description: z.string().optional(),
  title: z.string(),
  editedFiles: z.array(z.string()),
  messages: z
    .array(z.custom<BaseMessage>())
    .register(registry, MessagesZodMeta),
  context: z.string().optional(),
  commets: z.array(
    z.custom<ReviewComment>(),
  ),
});

async function contextSearchCall(state: z.infer<typeof reviewState>) {
  console.log('Invoking agent');

  const message = new HumanMessage(`Please analyze the following merge request details to gather relevant context for a code review.
  Merge Request Title: ${state.title}
  Description: ${state.description ?? 'No description provided.'}
  Commits: ${state.commits.join('\n')}
  Edited Files: ${state.editedFiles.join(', ')}`);

  console.debug('Message to agent:', message.text);

  const contextResponse = await agent.invoke({
    messages: [...state.messages, message],
  });

  const contextMessage = contextResponse.messages[contextResponse.messages.length - 1];

  console.log('Context message from agent:', contextMessage?.text);

  return {
    ...state,
    context: contextMessage?.text,
    messages: [...state.messages, message, contextMessage],
  };
}

async function reviewCall(state: z.infer<typeof reviewState>) {
  const prompt = [
    'You are performing a code review for a merge request.',
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
    'MR diff:',
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

  // 3) Run Claude Code via the Agent SDK in "review-only" mode
  const q = query({
    prompt,
    options: {
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

      // Safety: allow only read/search tools.
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Edit', 'Write'],
      executable: 'node',
      permissionMode: 'default',
      // If you later allow Bash, use canUseTool to whitelist safe commands. [page:1][page:2]
      canUseTool: async (toolName, input) => {
        // Hard deny edits even if something in settings enables them.
        if (toolName === 'Edit' || toolName === 'Write') {
          return { behavior: 'deny', message: 'Review node is read-only.' };
        }
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });

  let finalResult: any | null = null;

  // eslint-disable-next-line no-restricted-syntax
  for await (const msg of q) {
    if (msg.type === 'result') {
      finalResult = msg;
    }
  }

  if (!finalResult || finalResult.subtype !== 'success') {
    throw new Error(`Claude Code review failed: ${finalResult?.subtype ?? 'unknown'}`);
  }

  const structured = finalResult.structured_output as { comments: ReviewComment[] } | undefined;
  const comments = structured?.comments ?? [];

  return {
    ...state,
    commets: comments,
  };
}

const graph = new StateGraph(reviewState)
  .addNode('contextSearchCall', contextSearchCall)
  .addNode('reviewCall', reviewCall)
  .addEdge(START, 'contextSearchCall')
  .addEdge('contextSearchCall', 'reviewCall')
  .compile();

type ReviewInput = {
  title: string,
  diff: string,
  commits: string[],
  editedFiles: string[],
  sourceHash: string,
  sourceName: string,
  targetHash: string,
  targetName: string,
  description: string,
};

const startReview = (input: ReviewInput) => {
  const {
    title, commits, diff, editedFiles, description,
  } = input;

  return graph.invoke({
    commits, title, description, diff, editedFiles, messages: [],
  });
};

export default startReview;
