import { beforeEach, describe, expect, it, mock } from "bun:test";
import type LocalCache from "../../../cache/local-cache";
import type { GitProvider, PullRequest } from "../../../git-providers/types";
import type { ContextGatherer } from "../../../review/context-gatherer";
import type { ContextEvent, ReviewCommentWithId } from "../../../review/types";
import type { WorkflowState } from "../../types";
import { ActionExecutor } from "../action-executor";
import type { CommentDisplayService } from "../comment-display-service";
import type { CommentResolutionManager } from "../comment-resolution-manager";
import type { FixSessionOrchestrator } from "../fix-session-orchestrator";
import type { PRWorkflowManager } from "../pr-workflow-manager";
import type { ReviewStreamHandler } from "../review-stream-handler";

// Mock UI logger
const mockSpinner = {
	start: mock(() => {}),
	stop: mock(() => {}),
};

mock.module("../../../ui/logger", () => ({
	ui: {
		spinner: mock(() => mockSpinner),
		success: mock(() => {}),
		error: mock(() => {}),
		info: mock(() => {}),
		outro: mock(() => {}),
		section: mock(() => {}),
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
	let mockReviewHandler: ReviewStreamHandler;
	let mockCommentResolution: CommentResolutionManager;
	let mockFixSession: FixSessionOrchestrator;
	let mockCommentDisplay: CommentDisplayService;
	let mockContextGatherer: ContextGatherer;
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

		mockReviewHandler = {
			determineContextStrategy: mock(async () => ({
				gatherContext: true,
				refreshCache: false,
			})),
			processReviewStream: mock(async () => ({
				contextHasError: false,
				reviewHasError: false,
			})),
		} as unknown as ReviewStreamHandler;

		mockCommentResolution = {
			handleComments: mock(async () => ({
				processed: 0,
				fixed: 0,
				accepted: 0,
				rejected: 0,
				skipped: 0,
			})),
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

		mockCache = {
			getComments: mock(async () => []),
			set: mock(() => {}),
		} as unknown as LocalCache;

		actionExecutor = new ActionExecutor(
			mockPRWorkflow,
			mockReviewHandler,
			mockCommentResolution,
			mockFixSession,
			mockCommentDisplay,
			mockContextGatherer,
			mockCache,
		);
	});

	describe("executeReview", () => {
		it("should execute review successfully", async () => {
			// Mock cache to return no comments (so commentsCreated = 0)
			mockCache.getComments = mock(async () => []);

			const result = await actionExecutor.executeReview(samplePR, sampleState);

			expect(mockPRWorkflow.fetchCommitHistory).toHaveBeenCalledWith(samplePR);
			expect(mockPRWorkflow.analyzeChanges).toHaveBeenCalledWith(samplePR);
			expect(mockReviewHandler.determineContextStrategy).not.toHaveBeenCalled();
			expect(mockReviewHandler.processReviewStream).toHaveBeenCalled();
			expect(result.hasErrors).toBe(false);
			expect(result.commentsCreated).toBe(0);
		});

		it("should return comments created during review", async () => {
			// Mock cache to return 2 pending comments
			const pendingComments: ReviewCommentWithId[] = [
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
			mockCache.getComments = mock(async () => pendingComments);

			const result = await actionExecutor.executeReview(samplePR, sampleState);

			expect(result.commentsCreated).toBe(2);
			expect(result.hasErrors).toBe(false);
		});

		it("should handle review errors", async () => {
			mockReviewHandler.processReviewStream = mock(async () => ({
				contextHasError: false,
				reviewHasError: true,
			}));

			const result = await actionExecutor.executeReview(samplePR, sampleState);

			expect(result.hasErrors).toBe(true);
		});

		it("should handle context errors", async () => {
			mockReviewHandler.processReviewStream = mock(async () => ({
				contextHasError: true,
				reviewHasError: false,
			}));

			const result = await actionExecutor.executeReview(samplePR, sampleState);

			expect(result.hasErrors).toBe(true);
		});

		it("should display review summary when comments exist", async () => {
			mockCache.getComments = mock(
				async () =>
					[
						{
							id: "1",
							file: "test.ts",
							message: "Test",
							status: "pending",
						},
					] satisfies ReviewCommentWithId[],
			);

			await actionExecutor.executeReview(samplePR, sampleState);

			expect(mockCommentDisplay.displayReviewSummary).toHaveBeenCalled();
		});

		it("should handle exceptions gracefully", async () => {
			mockPRWorkflow.fetchCommitHistory = mock(async () => {
				throw new Error("Network error");
			});

			const result = await actionExecutor.executeReview(samplePR, sampleState);

			expect(result.hasErrors).toBe(true);
			expect(result.commentsCreated).toBe(0);
		});
	});

	describe("executeHandlePending", () => {
		it("should execute comment handling successfully", async () => {
			const result = await actionExecutor.executeHandlePending(samplePR);

			expect(mockCommentResolution.handleComments).toHaveBeenCalled();
			expect(result.processed).toBeGreaterThanOrEqual(0);
		});

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
					] satisfies ReviewCommentWithId[],
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
					] satisfies ReviewCommentWithId[],
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
					] satisfies ReviewCommentWithId[],
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

			await actionExecutor.executeGatherContext(samplePR, false);

			expect(mockPRWorkflow.fetchCommitHistory).toHaveBeenCalledWith(samplePR);
			expect(mockPRWorkflow.analyzeChanges).toHaveBeenCalledWith(samplePR);
			expect(mockContextGatherer.gather).toHaveBeenCalled();
			expect(setCacheMock).toHaveBeenCalled();
		});

		it("should handle refresh flag", async () => {
			await actionExecutor.executeGatherContext(samplePR, true);

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

			await actionExecutor.executeGatherContext(samplePR, false);

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

			await actionExecutor.executeGatherContext(samplePR, false);

			console.error = consoleError;

			// Should complete without throwing
			expect(mockPRWorkflow.fetchCommitHistory).toHaveBeenCalled();
		});
	});
});
