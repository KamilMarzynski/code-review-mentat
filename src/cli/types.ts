/**
 * Workflow state machine types for the CLI orchestrator
 */

/**
 * Available workflow actions that can be executed
 */
export type WorkflowAction =
	| "gather_context" // Available when there is no context yet
	| "refresh_context" // Available when context exists but outdated
	| "run_review" // Always available (with warnings if no context)
	| "handle_pending" // Available when pendingCount > 0
	| "send_accepted" // Available when acceptedCount > 0
	| "handle_remote" // Available when hasRemoteComments (future)
	| "exit"; // Always available

/**
 * Metadata about gathered context
 */
export interface ContextMetadata {
	gatheredAt: Date;
	gatheredFromCommit: string;
}

/**
 * Complete workflow state detection
 */
export interface WorkflowState {
	// Context state
	hasContext: boolean;
	contextUpToDate: boolean; // gathered commit === current PR commit
	contextMeta?: ContextMetadata;

	// Review/Comments state
	hasComments: boolean;
	pendingCount: number;
	acceptedCount: number;
	fixedCount: number;
	rejectedCount: number;

	// Future: Remote comments state
	hasRemoteComments: boolean;
	remoteCommentsCount: number;

	// PR state
	currentCommit: string;
	hasNewCommits: boolean; // since last context/review
}

/**
 * Menu option for workflow selection
 */
export interface MenuOption {
	value: WorkflowAction;
	label: string;
	hint?: string;
	recommended?: boolean; // Shows ⭐ indicator
	requiresContext?: boolean; // For warnings
	warningHint?: string; // Special warning to display
}
