import { ChatAnthropic } from '@langchain/anthropic';
import { registry } from '@langchain/langgraph/zod';
import { type BaseMessage, SystemMessage } from '@langchain/core/messages';
import { MessagesZodMeta, START, StateGraph } from '@langchain/langgraph';
import * as z from 'zod';

const model = new ChatAnthropic({
  model: 'claude-sonnet-4-5-20250929',
  temperature: 0,
});

const messagesState = z.object({
  messages: z
    .array(z.custom<BaseMessage>())
    .register(registry, MessagesZodMeta),
  llmCalls: z.number().optional(),
});

async function llmCall(state: z.infer<typeof messagesState>) {
  return {
    messages: await model.invoke([
      new SystemMessage(
        'You are an assistant capable of fetching information about merge reqeust based on merge request history and diff.'
        + 'Your task is to find information about jira ticket in merge request data, commits, descritpion or title and fetch this ticket information from jira system.'
        + 'If you cannot find jira ticket, do not make up any information, continue'
        + 'Next try to find information in confluence system about anything that migh help to do code review of this merge request.',
      ),
      ...state.messages,
    ]),
    llmCalls: (state.llmCalls ?? 0) + 1,
  };
}

export default new StateGraph(messagesState)
  .addNode('llmCall', llmCall)
  .addEdge(START, 'llmCall')
  .compile();
