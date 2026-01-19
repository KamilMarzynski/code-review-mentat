import { beforeEach, describe, expect, it, mock } from "bun:test";
import type LocalCache from "../../../cache/local-cache";
import type { PullRequest } from "../../../git-providers/types";
import type { CodeReviewer } from "../../../review/code-reviewer";
import type { ContextGatherer } from "../../../review/context-gatherer";
import type { ContextGathererFactory } from "../../../review/context-gatherer-factory";
import type {
	ContextEvent,
	ReviewEvent,
	StoredReviewComment,
} from "../../../review/types";
import type { WorkflowState } from "../../types";
import { ActionExecutor } from "../action-executor";
import type { CommentDisplayService } from "../comment-display-service";
import type { CommentResolutionManager } from "../comment-resolution-manager";
import type { FixSessionOrchestrator } from "../fix-session-orchestrator";
import type { PRWorkflowManager } from "../pr-workflow-manager";

// Mock UI logger
const mockSpinner = {
	start: mock(() => {}),
	stop: mock(() => {}),
	message: mock(() => {}),
};

mock.module("../../../ui/logger", () => ({
	ui: {
		spinner: mock(() => mockSpinner),
		success: mock(() => {}),
		error: mock(() => {}),
		info: mock(() => {}),
		outro: mock(() => {}),
		section: mock(() => {}),
		sectionComplete: mock(() => {}),
		step: mock(() => {}),
	},
}));

/**
 * Unit tests for ActionExecutor
 *
 * Tests action execution logic with mocked dependencies
 */
describe("ActionExecutor", () => {
	let actionExecutor: ActionExecutor;
	let mockPRWorkflow: PRWorkflowManager;
	let mockCommentResolution: CommentResolutionManager;
	let mockFixSession: FixSessionOrchestrator;
	let mockCommentDisplay: CommentDisplayService;
	let mockContextGatherer: ContextGatherer;
	let mockContextGathererFactory: ContextGathererFactory;
	let mockCodeReviewer: CodeReviewer;
	let mockCache: LocalCache;

	// Sample pull request for testing
	const samplePR: PullRequest = {
		id: 123,
		title: "Test PR",
		description: "Test description",
		source: {
			name: "feature-branch",
			commitHash: "abc123def456",
		},
		target: {
			name: "main",
			commitHash: "def456ghi789",
		},
	};

	const sampleState: WorkflowState = {
		hasContext: true,
		contextUpToDate: true,
		hasComments: false,
		pendingCount: 0,
		acceptedCount: 0,
		fixedCount: 0,
		rejectedCount: 0,
		hasRemoteComments: false,
		remoteCommentsCount: 0,
		currentCommit: "abc123def456",
		hasNewCommits: false,
	};

	beforeEach(() => {
		// Create mock instances
		mockPRWorkflow = {
			fetchCommitHistory: mock(async () => ["commit 1", "commit 2"]),
			analyzeChanges: mock(async () => ({
				fullDiff: "diff content",
				editedFiles: ["file1.ts", "file2.ts"],
			})),
			postCommentsToRemote: mock(async () => {}),
		} as unknown as PRWorkflowManager;

		mockCommentResolution = {
			handleComments: mock(async () => ({
				processed: 0,
				fixed: 0,
				accepted: 0,
				rejected: 0,
				skipped: 0,
			})),
			saveCommentsToCache: mock(async () => {}),
			getPendingComments: mock(() => []),
			getAcceptedComments: mock(() => []),
			getRejectedComments: mock(() => []),
		} as unknown as CommentResolutionManager;

		mockFixSession = {
			runFixSession: mock(async () => {}),
		} as unknown as FixSessionOrchestrator;

		mockCommentDisplay = {
			displayReviewSummary: mock(() => {}),
			promptOptionalNotes: mock(async () => undefined),
			displayCommentWithContext: mock(async () => {}),
		} as unknown as CommentDisplayService;

		mockContextGatherer = {
			gather: mock(async function* () {
				yield {
					type: "context_start",
					metadata: { timestamp: Date.now() },
				};
				yield {
					type: "context_success",
					dataSource: "live",
					metadata: { timestamp: Date.now() },
				};
				yield {
					type: "context_data",
					data: {
						sourceBranch: "feature",
						targetBranch: "main",
						currentCommit: "abc123",
						context: "Test context",
					},
					metadata: { timestamp: Date.now() },
				};
			}),
		} as unknown as ContextGatherer;

		mockContextGathererFactory = {
			create: mock(() => mockContextGatherer),
		} as unknown as ContextGathererFactory;

		mockCodeReviewer = {
			review: mock(async function* () {
				yield {
					type: "review_start",
					metadata: { timestamp: Date.now() },
				};
				yield {
					type: "review_data",
					data: {
						sourceBranch: "feature",
						targetBranch: "main",
						currentCommit: "abc123",
						comments: [],
					},
					metadata: { timestamp: Date.now() },
				};
				yield {
					type: "review_success",
					dataSource: "live",
					commentCount: 0,
					metadata: { timestamp: Date.now() },
				};
			}),
			reviewNode: mock(() => Promise.resolve({})),
		} as unknown as CodeReviewer;

		mockCache = {
			get: mock(() => undefined),
			getComments: mock(async () => []),
			set: mock(() => {}),
			setCacheMock: mock(() => {}),
		} as unknown as LocalCache;
		actionExecutor = new ActionExecutor(
			mockPRWorkflow,
			mockCommentResolution,
			mockFixSession,
			mockCommentDisplay,
			mockContextGathererFactory,
			mockCodeReviewer,
			mockCache,
		);
	});

	describe("executeReview", () => {
		it("should execute review successfully", async () => {
			// Add logging to verify the mock is being called
			let reviewCalled = false;
			mockCodeReviewer.review = mock(async function* () {
				reviewCalled = true;
				yield {
					type: "review_start",
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
				yield {
					type: "review_data",
					data: {
						sourceBranch: "feature",
						targetBranch: "main",
						currentCommit: "abc123",
						comments: [],
					},
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
				yield {
					type: "review_success",
					dataSource: "live",
					commentCount: 0,
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
			});

			const result = await actionExecutor.executeReview(samplePR);

			expect(reviewCalled).toBe(true);
			expect(mockPRWorkflow.fetchCommitHistory).toHaveBeenCalledWith(samplePR);
			expect(mockPRWorkflow.analyzeChanges).toHaveBeenCalledWith(samplePR);
			expect(mockCodeReviewer.review).toHaveBeenCalled();
			expect(mockCommentResolution.saveCommentsToCache).toHaveBeenCalled();
			expect(result.hasErrors).toBe(false);
			expect(result.commentsCreated).toBe(0);
		});

		it("should return comments created during review", async () => {
			// Mock cache to return 2 pending comments
			const pendingComments: StoredReviewComment[] = [
				{
					id: "1",
					file: "test.ts",
					message: "Test comment",
					status: "pending",
					line: 10,
				},
				{
					id: "2",
					file: "test.ts",
					message: "Test comment 2",
					status: "pending",
					line: 20,
				},
			];

			// Mock the review generator to yield comments
			mockCodeReviewer.review = mock(async function* () {
				yield {
					type: "review_start",
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
				yield {
					type: "review_data",
					data: {
						sourceBranch: "feature",
						targetBranch: "main",
						currentCommit: "abc123",
						comments: pendingComments,
					},
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
				yield {
					type: "review_success",
					dataSource: "live",
					commentCount: 2,
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
			});

			// Mock the cache to return the comments after save
			mockCache.getComments = mock(async () => pendingComments);

			const result = await actionExecutor.executeReview(samplePR);

			expect(result.commentsCreated).toBe(2);
			expect(result.hasErrors).toBe(false);
		});

		it("should handle review errors", async () => {
			// Mock the review generator to yield an error event
			mockCodeReviewer.review = mock(async function* () {
				yield {
					type: "review_start",
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
				yield {
					type: "review_error",
					message: "Review failed",
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
			});

			const result = await actionExecutor.executeReview(samplePR);

			expect(result.hasErrors).toBe(true);
		});

		it("should display review summary when comments exist", async () => {
			const comments: StoredReviewComment[] = [
				{
					id: "1",
					file: "test.ts",
					message: "Test",
					status: "pending",
					line: 10,
				},
			];

			// Mock the review generator to yield comments
			mockCodeReviewer.review = mock(async function* () {
				yield {
					type: "review_start",
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
				yield {
					type: "review_data",
					data: {
						sourceBranch: "feature",
						targetBranch: "main",
						currentCommit: "abc123",
						comments: comments,
					},
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
				yield {
					type: "review_success",
					dataSource: "live",
					commentCount: 1,
					metadata: { timestamp: Date.now() },
				} satisfies ReviewEvent;
			});

			// Mock the cache to return the comments
			mockCache.getComments = mock(async () => comments);

			await actionExecutor.executeReview(samplePR);

			expect(mockCommentDisplay.displayReviewSummary).toHaveBeenCalled();
		});

		it("should handle exceptions gracefully", async () => {
			mockPRWorkflow.fetchCommitHistory = mock(async () => {
				throw new Error("Network error");
			});

			const result = await actionExecutor.executeReview(samplePR);

			expect(result.hasErrors).toBe(true);
			expect(result.commentsCreated).toBe(0);
		});
	});

	describe("executeHandlePending", () => {
		it("should track comment resolution summary", async () => {
			// Mock handleComments to return a specific result
			mockCommentResolution.handleComments = mock(async () => {
				return {
					processed: 4,
					fixed: 1,
					accepted: 2,
					rejected: 1,
					skipped: 0,
				};
			});

			const result = await actionExecutor.executeHandlePending(samplePR);

			expect(mockCommentResolution.handleComments).toHaveBeenCalled();
			expect(result.fixed).toBe(1);
			expect(result.accepted).toBe(2);
			expect(result.rejected).toBe(1);
			expect(result.processed).toBe(4);
		});

		it("should handle exceptions gracefully", async () => {
			mockCommentResolution.handleComments = mock(async () => {
				throw new Error("Handling error");
			});

			const result = await actionExecutor.executeHandlePending(samplePR);

			expect(result.processed).toBe(0);
			expect(result.fixed).toBe(0);
		});
	});

	describe("executeSendAccepted", () => {
		it("should send accepted comments successfully", async () => {
			mockCache.getComments = mock(
				async () =>
					[
						{
							id: "1",
							file: "test.ts",
							message: "Test",
							status: "accepted",
						},
						{
							id: "2",
							file: "test.ts",
							message: "Test 2",
							status: "accepted",
						},
					] satisfies StoredReviewComment[],
			);

			const count = await actionExecutor.executeSendAccepted(samplePR);

			expect(count).toBe(2);
			expect(mockPRWorkflow.postCommentsToRemote).toHaveBeenCalled();
		});

		it("should return 0 when no accepted comments exist", async () => {
			mockCache.getComments = mock(
				async () =>
					[
						{
							id: "1",
							file: "test.ts",
							message: "Test",
							status: "pending",
						},
					] satisfies StoredReviewComment[],
			);

			const count = await actionExecutor.executeSendAccepted(samplePR);

			expect(count).toBe(0);
			expect(mockPRWorkflow.postCommentsToRemote).not.toHaveBeenCalled();
		});

		it("should handle exceptions gracefully", async () => {
			mockCache.getComments = mock(
				async () =>
					[
						{
							id: "1",
							file: "test.ts",
							message: "Test",
							status: "accepted",
						},
					] satisfies StoredReviewComment[],
			);

			mockPRWorkflow.postCommentsToRemote = mock(async () => {
				throw new Error("Network error");
			});

			const count = await actionExecutor.executeSendAccepted(samplePR);

			expect(count).toBe(0);
		});
	});

	describe("executeGatherContext", () => {
		it("should execute context gathering", async () => {
			// Reset the cache set mock to track calls and ensure gather mock is fresh
			const setCacheMock = mock(() => {});
			mockCache.set = setCacheMock;

			// Recreate the gather mock for this test to ensure it's fresh
			mockContextGatherer.gather = mock(async function* () {
				yield {
					type: "context_start",
					metadata: { timestamp: Date.now() },
				} satisfies ContextEvent;
				yield {
					type: "context_data",
					data: {
						sourceBranch: "feature",
						targetBranch: "main",
						currentCommit: "abc123",
						context: "Test context",
					},
					metadata: { timestamp: Date.now() },
				} satisfies ContextEvent;
				yield {
					type: "context_success",
					dataSource: "live",
					metadata: { timestamp: Date.now() },
				} satisfies ContextEvent;
			});

			await actionExecutor.executeGatherContext(samplePR);

			expect(mockPRWorkflow.fetchCommitHistory).toHaveBeenCalledWith(samplePR);
			expect(mockPRWorkflow.analyzeChanges).toHaveBeenCalledWith(samplePR);
			expect(mockContextGatherer.gather).toHaveBeenCalled();
			expect(setCacheMock).toHaveBeenCalled();
		});

		it("should handle refresh flag", async () => {
			await actionExecutor.executeGatherContext(samplePR);

			expect(mockContextGatherer.gather).toHaveBeenCalled();
		});

		it("should handle errors gracefully", async () => {
			mockContextGatherer.gather = mock(async function* () {
				yield {
					type: "context_error",
					message: "Failed to gather context",
					metadata: { timestamp: Date.now() },
				} satisfies ContextEvent;
			});

			await actionExecutor.executeGatherContext(samplePR);

			// Should complete without throwing
			expect(mockContextGatherer.gather).toHaveBeenCalled();
		});

		it("should handle exceptions gracefully", async () => {
			mockPRWorkflow.fetchCommitHistory = mock(async () => {
				throw new Error("Network error");
			});

			// Suppress console output for this test
			const consoleError = console.error;
			console.error = () => {};

			await actionExecutor.executeGatherContext(samplePR);

			console.error = consoleError;

			// Should complete without throwing
			expect(mockPRWorkflow.fetchCommitHistory).toHaveBeenCalled();
		});
	});
});
