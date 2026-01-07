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
  context?: string,
};

export type StreamEventMetadata = {
  timestamp: number;
}

/**
 * Base event types that can be emitted by any node
 */
export type StreamEvent<TPrefix extends EventType = EventType> =
  (| {
    type: `${TPrefix}_start`;
  }
    | {
      type: `${TPrefix}_thinking`;
      text: string;
    }
    | {
      type: `${TPrefix}_tool_call`;
      toolName: string;
      input: string;
    }
    | {
      type: `${TPrefix}_tool_call_reasoning`;
      message: string;
    }
    | {
      type: `${TPrefix}_tool_result`;
    }
    | {
      type: `${TPrefix}_success`;
      dataSource: 'cache' | 'live';
      commentCount?: number;
      metadata?: Record<string, unknown>;
    }
    | {
      type: `${TPrefix}_error`;
      message: string;
      error?: Error;
    }
    | {
      type: `${TPrefix}_data`;
      data: DataEventData<TPrefix>;
    }) & {
      metadata: StreamEventMetadata;
    };

export enum EventType {
  CONTEXT = 'context',
  REVIEW = 'review',
}

export type DataEventData<T extends EventType> = T extends EventType.CONTEXT
  ? {
      sourceBranch: string;
      targetBranch: string;
      currentCommit: string;
      context: string;
    }
  : T extends EventType.REVIEW
    ? {
        sourceBranch: string;
        targetBranch: string;
        currentCommit: string;
        comments: ReviewComment[];
      }
    : never;

/**
 * Context gathering events
 */
export type ContextEvent = StreamEvent<EventType.CONTEXT>;

/**
 * Code review events
 */
export type ReviewEvent = StreamEvent<EventType.REVIEW>;

/**
 * All possible streaming events
 */
export type NodeEvent = ContextEvent | ReviewEvent;

/**
 * Type guard helpers
 */
export function isContextEvent(event: NodeEvent): event is ContextEvent {
  return event.type.startsWith('context_');
}

export function isReviewEvent(event: NodeEvent): event is ReviewEvent {
  return event.type.startsWith('review_');
}

/**
 * Extract specific event types
 */
export type EventOfType<
  T extends NodeEvent,
  Type extends T['type']
> = Extract<T, { type: Type }>;

// Usage examples:
// type ToolCallEvent = EventOfType<ContextEvent, 'context_tool_call'>;
// type ThinkingEvent = EventOfType<ReviewEvent, 'review_thinking'>;

export type ReviewOutput = Required<Omit<ReviewState, 'sourceHash' | 'targetHash' | 'gatherContext' | 'refreshCache' | 'commits' | 'diff' | 'editedFiles' | 'title' | 'description' | 'messages' | 'sourceBranch' | 'targetBranch'>>;
