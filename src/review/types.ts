import type { BaseMessage } from "@langchain/core/messages";
import type { MemorySearchResult } from "../memory/types";

export type ReviewCommentStatus =
	| "pending" // Not yet addressed
	| "fixed" // Fixed and accepted
	| "accepted" // Accepted as-is
	| "rejected" // Rejected
	| "posted" // Posted to remote PR
	| "imported"; // Fetched from remote reviewer

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

export type ImportMetadata = {
	remoteId: string; // provider's comment ID
	remoteAuthor: string; // reviewer's username
	remoteUrl: string; // permalink to original comment
	importedAt: string; // ISO timestamp of fetch
	resolvedOnRemote: boolean; // whether comment is resolved on remote
};

export type StoredReviewComment = ReviewComment & {
	id: string;
	codeSnippet?: string;
	remoteCommentId?: number; // outbound: ID after posting agent comment
	remoteCommentUrl?: string; // outbound: URL after posting agent comment
	source?: "generated" | "imported";
	importMeta?: ImportMetadata;
};

export type GeneratedComment = StoredReviewComment & {
	source: "generated";
	status: "pending" | "accepted" | "fixed" | "rejected" | "posted";
	importMeta?: never;
};

export type ImportedComment = StoredReviewComment & {
	source: "imported";
	// "pending" excluded intentionally: imported comments are not agent-generated
	// so they cannot be accepted/posted. Lifecycle: imported → fixed | rejected.
	status: "imported" | "fixed" | "rejected";
	importMeta: ImportMetadata;
};

// AnyStoredComment is used where source is guaranteed to be set.
// Comments deserialized from cache before this feature have source === undefined
// and are StoredReviewComment (not AnyStoredComment). Use isImportedComment()
// or filter by source === "imported" directly when working with mixed sets.
export type AnyStoredComment = GeneratedComment | ImportedComment;

export function isImportedComment(
	c: StoredReviewComment,
): c is ImportedComment {
	return c.source === "imported" && c.importMeta != null;
}

export function isGeneratedComment(
	c: StoredReviewComment,
): c is GeneratedComment {
	return c.source === "generated";
}

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
	memories?: MemorySearchResult[];
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
