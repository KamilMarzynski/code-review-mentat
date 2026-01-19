import type { BaseMessage } from "@langchain/core/messages";

export type ReviewCommentStatus =
	| "pending" // Not yet addressed
	| "fixed" // Fixed and accepted
	| "accepted" // Accepted as-is
	| "rejected"; // Rejected

export type ReviewComment = {
	id?: string;
	file: string;
	line?: number;
	startLine?: number;
	endLine?: number;
	severity?: "nit" | "suggestion" | "issue" | "risk";
	message: string;
	rationale?: string;
	status: ReviewCommentStatus;
	confidence?: "high" | "medium" | "low";
	verifiedBy?: string; // Tool used to verify (e.g., "Grep: found 3 usages")
	memoryCreated?: boolean; // Track if memory was created for this comment
};

export type StoredReviewComment = ReviewComment & {
	id: string;
	codeSnippet?: string; // Code snippet related to the comment
};

export type FixIteration = {
	attemptNumber: number;
	claudeThinking: string; // Claude's reasoning
	suggestedDiff: string;
	userFeedback?: string; // User asked to refine
	userFeedbackReason?: string; // Why they rejected
	timestamp: number;
};

export type ContextGatherInput = {
	title: string;
	description?: string;
	commits: string[];
	editedFiles: string[];
	sourceBranch: string;
	targetBranch: string;
	sourceHash: string;
};

export type ContextGatherOutput = ContextGatherInput & {
	context: string;
	messages: BaseMessage[];
};

export type ReviewInput = {
	context?: string;
	editedFiles: string[];
	commits: string[];
	diff: string;
	sourceBranch: string;
	targetBranch: string;
	sourceHash: string;
};

export type ReviewOutput = {
	comments: ReviewComment[];
	result: string;
};

export type StreamEventMetadata = {
	timestamp: number;
};

/**
 * Base event types that can be emitted by any node
 */
export type StreamEvent<TPrefix extends EventType = EventType> = (
	| {
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
			dataSource: "cache" | "live";
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
	  }
) & {
	metadata: StreamEventMetadata;
};

export enum EventType {
	CONTEXT = "context",
	REVIEW = "review",
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
	return event.type.startsWith("context_");
}

export function isReviewEvent(event: NodeEvent): event is ReviewEvent {
	return event.type.startsWith("review_");
}

/**
 * Extract specific event types
 */
export type EventOfType<T extends NodeEvent, Type extends T["type"]> = Extract<
	T,
	{ type: Type }
>;

// Usage examples:
// type ToolCallEvent = EventOfType<ContextEvent, 'context_tool_call'>;
// type ThinkingEvent = EventOfType<ReviewEvent, 'review_thinking'>;
