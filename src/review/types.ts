import type { BaseMessage } from '@langchain/core/messages';
import * as z from 'zod';
import { MessagesZodMeta } from '@langchain/langgraph';
import { registry } from '@langchain/langgraph/zod';

export type ReviewComment = {
  file: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  severity?: 'nit' | 'suggestion' | 'issue' | 'risk';
  message: string;
  rationale?: string;
};

export const reviewState = z.object({
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

export type ReviewState = z.infer<typeof reviewState>;

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

export type ReviewOutput = Required<Omit<ReviewState, 'sourceHash' | 'targetHash' | 'gatherContext' | 'refreshCache' | 'commits' | 'diff' | 'editedFiles' | 'title' | 'description' | 'messages' | 'sourceBranch' | 'targetBranch'>>;
