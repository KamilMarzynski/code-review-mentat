import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PullRequest } from "../../../git-providers/types";
import type {
	HandleCommentsResult,
	ReviewResult,
	WorkflowState,
} from "../../types";
import { PostActionHandler } from "../post-action-handler";
import type { WorkflowStateManager } from "../workflow-state-manager";

// Mock clack module
const mockConfirm = mock(() => Promise.resolve(true));
const mockSelect = mock(() => Promise.resolve("show_menu"));
const mockIsCancel = mock(() => false);

mock.module("@clack/prompts", () => ({
	confirm: mockConfirm,
	select: mockSelect,
	isCancel: mockIsCancel,
}));

// Mock logger
mock.module("../../../ui/logger", () => ({
	ui: {
		success: mock(() => {}),
		error: mock(() => {}),
		info: mock(() => {}),
	},
}));

describe("PostActionHandler", () => {
	let handler: PostActionHandler;
	let mockStateManager: WorkflowStateManager;
	let mockPr: PullRequest;
	let baseState: WorkflowState;

	beforeEach(() => {
		// Reset all mocks
		mockConfirm.mockClear();
		mockSelect.mockClear();
		mockIsCancel.mockClear();
		mockIsCancel.mockReturnValue(false);

		// Create mock PR
		mockPr = {
			id: 1,
			title: "Test PR",
			source: { name: "feature", commitHash: "abc123" },
			target: { name: "main", commitHash: "def456" },
			description: "Test description",
		} as PullRequest;

		// Create base state
		baseState = {
			hasContext: true,
			contextUpToDate: true,
			contextMeta: {
				gatheredAt: new Date(),
				gatheredFromCommit: "abc123",
			},
			hasComments: false,
			pendingCount: 0,
			acceptedCount: 0,
			fixedCount: 0,
			rejectedCount: 0,
			hasRemoteComments: false,
			remoteCommentsCount: 0,
			currentCommit: "abc123",
			hasNewCommits: false,
		};

		// Create mock state manager
		mockStateManager = {
			detectState: mock(() => Promise.resolve(baseState)),
		} as unknown as WorkflowStateManager;

		// Create handler
		handler = new PostActionHandler(mockStateManager);
	});

	describe("afterContextGathered", () => {
		test("should prompt to run review when no pending comments and user confirms", async () => {
			mockConfirm.mockResolvedValue(true);

			const result = await handler.afterContextGathered(mockPr);

			expect(result).toBe("run_review");
			expect(mockConfirm).toHaveBeenCalledTimes(1);
			expect(mockSelect).not.toHaveBeenCalled();
		});

		test("should return to menu when no pending comments and user declines", async () => {
			mockConfirm.mockResolvedValue(false);

			const result = await handler.afterContextGathered(mockPr);

			expect(result).toBe("show_menu");
			expect(mockConfirm).toHaveBeenCalledTimes(1);
		});

		test("should return to menu when no pending comments and user cancels", async () => {
			mockIsCancel.mockReturnValue(true);

			const result = await handler.afterContextGathered(mockPr);

			expect(result).toBe("show_menu");
		});

		test("should show options when has pending comments", async () => {
			// Update state to have pending comments
			baseState.pendingCount = 3;
			baseState.hasComments = true;
			mockSelect.mockResolvedValue("handle_pending");

			const result = await handler.afterContextGathered(mockPr);

			expect(result).toBe("handle_pending");
			expect(mockConfirm).not.toHaveBeenCalled();
			expect(mockSelect).toHaveBeenCalledTimes(1);

			// Verify select was called with proper options
			const selectCall = (mockSelect as any).mock.calls[0][0];
			expect(selectCall.options).toHaveLength(3);
			expect(selectCall.options[0].value).toBe("handle_pending");
			expect(selectCall.options[1].value).toBe("run_review");
			expect(selectCall.options[2].value).toBe("show_menu");
		});

		test("should handle user selecting run_review when has pending", async () => {
			baseState.pendingCount = 5;
			baseState.hasComments = true;
			mockSelect.mockResolvedValue("run_review");

			const result = await handler.afterContextGathered(mockPr);

			expect(result).toBe("run_review");
		});

		test("should return to menu when user cancels with pending comments", async () => {
			baseState.pendingCount = 2;
			baseState.hasComments = true;
			mockIsCancel.mockReturnValue(true);

			const result = await handler.afterContextGathered(mockPr);

			expect(result).toBe("show_menu");
		});
	});

	describe("afterReviewCompleted", () => {
		test("should return to menu when no comments created", async () => {
			const reviewResult: ReviewResult = {
				commentsCreated: 0,
				hasErrors: false,
			};

			const result = await handler.afterReviewCompleted(reviewResult, mockPr);

			expect(result).toBe("show_menu");
			expect(mockConfirm).not.toHaveBeenCalled();
		});

		test("should return to menu when review has errors", async () => {
			const reviewResult: ReviewResult = {
				commentsCreated: 0,
				hasErrors: true,
			};

			const result = await handler.afterReviewCompleted(reviewResult, mockPr);

			expect(result).toBe("show_menu");
		});

		test("should prompt to handle pending when comments created and user confirms", async () => {
			const reviewResult: ReviewResult = {
				commentsCreated: 3,
				hasErrors: false,
			};
			baseState.pendingCount = 3;
			baseState.hasComments = true;
			mockConfirm.mockResolvedValue(true);

			const result = await handler.afterReviewCompleted(reviewResult, mockPr);

			expect(result).toBe("handle_pending");
			expect(mockConfirm).toHaveBeenCalledTimes(1);
		});

		test("should return to menu when user declines to handle pending", async () => {
			const reviewResult: ReviewResult = {
				commentsCreated: 2,
				hasErrors: false,
			};
			baseState.pendingCount = 2;
			baseState.hasComments = true;
			mockConfirm.mockResolvedValue(false);

			const result = await handler.afterReviewCompleted(reviewResult, mockPr);

			expect(result).toBe("show_menu");
		});

		test("should return to menu when user cancels", async () => {
			const reviewResult: ReviewResult = {
				commentsCreated: 1,
				hasErrors: false,
			};
			baseState.pendingCount = 1;
			mockIsCancel.mockReturnValue(true);

			const result = await handler.afterReviewCompleted(reviewResult, mockPr);

			expect(result).toBe("show_menu");
		});

		test("should handle singular vs plural comment messages", async () => {
			const reviewResult: ReviewResult = {
				commentsCreated: 1,
				hasErrors: false,
			};
			baseState.pendingCount = 1;
			baseState.hasComments = true;
			mockConfirm.mockResolvedValue(true);

			const result = await handler.afterReviewCompleted(reviewResult, mockPr);

			expect(result).toBe("handle_pending");
			// Verify the confirm was called with singular message
			const confirmCall = (mockConfirm as any).mock.calls[0][0];
			expect(confirmCall.message).toContain("1 pending comment now");
		});
	});

	describe("afterPendingHandled", () => {
		test("should return to menu when no accepted comments", async () => {
			const handleResult: HandleCommentsResult = {
				processed: 3,
				fixed: 2,
				accepted: 0,
				rejected: 1,
				skipped: 0,
			};
			baseState.acceptedCount = 0;

			const result = await handler.afterPendingHandled(handleResult, mockPr);

			expect(result).toBe("show_menu");
			expect(mockConfirm).not.toHaveBeenCalled();
		});

		test("should prompt to send accepted when has accepted and user confirms", async () => {
			const handleResult: HandleCommentsResult = {
				processed: 3,
				fixed: 1,
				accepted: 2,
				rejected: 0,
				skipped: 0,
			};
			baseState.acceptedCount = 2;
			mockConfirm.mockResolvedValue(true);

			const result = await handler.afterPendingHandled(handleResult, mockPr);

			expect(result).toBe("send_accepted");
			expect(mockConfirm).toHaveBeenCalledTimes(1);
		});

		test("should return to menu when user declines to send accepted", async () => {
			const handleResult: HandleCommentsResult = {
				processed: 2,
				fixed: 0,
				accepted: 2,
				rejected: 0,
				skipped: 0,
			};
			baseState.acceptedCount = 2;
			mockConfirm.mockResolvedValue(false);

			const result = await handler.afterPendingHandled(handleResult, mockPr);

			expect(result).toBe("show_menu");
		});

		test("should return to menu when user cancels", async () => {
			const handleResult: HandleCommentsResult = {
				processed: 1,
				fixed: 0,
				accepted: 1,
				rejected: 0,
				skipped: 0,
			};
			baseState.acceptedCount = 1;
			mockIsCancel.mockReturnValue(true);

			const result = await handler.afterPendingHandled(handleResult, mockPr);

			expect(result).toBe("show_menu");
		});

		test("should display summary with all resolution types", async () => {
			const handleResult: HandleCommentsResult = {
				processed: 10,
				fixed: 3,
				accepted: 4,
				rejected: 2,
				skipped: 1,
			};
			baseState.acceptedCount = 4;
			mockConfirm.mockResolvedValue(true);

			await handler.afterPendingHandled(handleResult, mockPr);

			// Test passes if no errors thrown during summary display
			expect(true).toBe(true);
		});

		test("should handle singular vs plural accepted messages", async () => {
			const handleResult: HandleCommentsResult = {
				processed: 1,
				fixed: 0,
				accepted: 1,
				rejected: 0,
				skipped: 0,
			};
			baseState.acceptedCount = 1;
			mockConfirm.mockResolvedValue(false);

			await handler.afterPendingHandled(handleResult, mockPr);

			// Verify the confirm was called with singular message
			const confirmCall = (mockConfirm as any).mock.calls[0][0];
			expect(confirmCall.message).toContain("1 accepted comment to");
		});
	});

	describe("afterAcceptedSent", () => {
		test("should always return show_menu", async () => {
			const result = await handler.afterAcceptedSent(mockPr);

			expect(result).toBe("show_menu");
		});

		test("should display success message", async () => {
			await handler.afterAcceptedSent(mockPr);

			// Test passes if no errors thrown
			expect(true).toBe(true);
		});
	});
});
