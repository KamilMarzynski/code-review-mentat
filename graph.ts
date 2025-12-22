import { ChatAnthropic } from '@langchain/anthropic';
import { createAgent, toolCallLimitMiddleware } from 'langchain';
import { registry } from '@langchain/langgraph/zod';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  MessagesZodMeta, START, StateGraph,
} from '@langchain/langgraph';
import * as z from 'zod';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';

const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

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

const limiter = toolCallLimitMiddleware({
  runLimit: 10,
  exitBehavior: 'error',
});

const tools = await client.getTools();

const model = new ChatAnthropic({
  model: 'claude-sonnet-4-5-20250929',
  temperature: 0,
});

const agent = createAgent({
  model,
  tools,
  middleware: [limiter],
  systemPrompt:
    'You are an assistant capable of fetching information about merge reqeust based on merge request history.'
    + 'You should be concrete and percise in your search. Limit the number of tool calls to avoid excessive calls. You are limitted to 10 tool calls per merge request.'
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
  review: z.string().optional(),
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

const graph = new StateGraph(reviewState)
  .addNode('contextSearchCall', contextSearchCall)
  .addEdge(START, 'contextSearchCall')
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
