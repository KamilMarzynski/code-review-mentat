import { beforeEach, describe, expect, it, mock } from "bun:test";
import type LocalCache from "../../../cache/local-cache";
import type { PullRequest } from "../../../git-providers/types";
import type { ReviewCommentWithId } from "../../../review/types";
import { WorkflowStateManager } from "../workflow-state-manager";

/**
 * Unit tests for WorkflowStateManager
 *
 * Tests state detection logic with various cache/comment combinations
 */
describe("WorkflowStateManager", () => {
	let stateManager: WorkflowStateManager;
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

	beforeEach(() => {
		// Create mock cache
		mockCache = {
			has: mock(() => false),
			getMetadata: mock(() => null),
			getComments: mock(async () => []),
		} as unknown as LocalCache;

		stateManager = new WorkflowStateManager(mockCache);
	});

	describe("detectState", () => {
		it("should detect clean state (no context, no comments)", async () => {
			const state = await stateManager.detectState(samplePR);

			expect(state).toMatchObject({
				hasContext: false,
				contextUpToDate: false,
				contextMeta: undefined,
				hasComments: false,
				pendingCount: 0,
				acceptedCount: 0,
				fixedCount: 0,
				rejectedCount: 0,
				hasRemoteComments: false,
				remoteCommentsCount: 0,
				currentCommit: "abc123def456",
				hasNewCommits: false,
			});
		});

		it("should detect context exists and is up-to-date", async () => {
			mockCache.has = mock(() => true);
			mockCache.getMetadata = mock(() => ({
				sourceBranch: "feature-branch",
				targetBranch: "main",
				gatheredAt: "2024-01-01T00:00:00.000Z",
				gatheredFromCommit: "abc123def456",
				repoPath: "/test/repo",
				version: "1.0",
			}));

			const state = await stateManager.detectState(samplePR);

			expect(state.hasContext).toBe(true);
			expect(state.contextUpToDate).toBe(true);
			expect(state.contextMeta).toBeDefined();
			expect(state.contextMeta?.gatheredFromCommit).toBe("abc123def456");
		});

		it("should detect context exists but is outdated", async () => {
			mockCache.has = mock(() => true);
			mockCache.getMetadata = mock(() => ({
				sourceBranch: "feature-branch",
				targetBranch: "main",
				gatheredAt: "2024-01-01T00:00:00.000Z",
				gatheredFromCommit: "old123commit",
				repoPath: "/test/repo",
				version: "1.0",
			}));

			const state = await stateManager.detectState(samplePR);

			expect(state.hasContext).toBe(true);
			expect(state.contextUpToDate).toBe(false);
			expect(state.hasNewCommits).toBe(true);
		});

		it("should count comments by status", async () => {
			mockCache.getComments = mock(
				async () =>
					[
						{
							id: "1",
							file: "test.ts",
							message: "Test 1",
							status: "pending",
						},
						{
							id: "2",
							file: "test.ts",
							message: "Test 2",
							status: "pending",
						},
						{
							id: "3",
							file: "test.ts",
							message: "Test 3",
							status: "accepted",
						},
						{
							id: "4",
							file: "test.ts",
							message: "Test 4",
							status: "fixed",
						},
						{
							id: "5",
							file: "test.ts",
							message: "Test 5",
							status: "rejected",
						},
					] satisfies ReviewCommentWithId[],
			);

			const state = await stateManager.detectState(samplePR);

			expect(state.hasComments).toBe(true);
			expect(state.pendingCount).toBe(2);
			expect(state.acceptedCount).toBe(1);
			expect(state.fixedCount).toBe(1);
			expect(state.rejectedCount).toBe(1);
		});

		it("should treat comments without status as pending", async () => {
			mockCache.getComments = mock(
				async () =>
					[
						{
							id: "1",
							file: "test.ts",
							message: "Test 1",
							status: "pending",
						},
						{
							id: "2",
							file: "test.ts",
							message: "Test 2",
							// No status field - intentionally using type assertion for test
							status: undefined,
						} as unknown as ReviewCommentWithId,
					] satisfies ReviewCommentWithId[],
			);

			const state = await stateManager.detectState(samplePR);

			expect(state.pendingCount).toBe(2);
		});
	});

	describe("getAvailableActions", () => {
		it("should include gather_context when no context exists", () => {
			const state = {
				hasContext: false,
				contextUpToDate: false,
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

			const actions = stateManager.getAvailableActions(state);

			expect(actions).toContain("gather_context");
			expect(actions).not.toContain("refresh_context");
		});

		it("should include refresh_context when context is outdated", () => {
			const state = {
				hasContext: true,
				contextUpToDate: false,
				contextMeta: {
					gatheredAt: new Date(),
					gatheredFromCommit: "old123",
				},
				hasComments: false,
				pendingCount: 0,
				acceptedCount: 0,
				fixedCount: 0,
				rejectedCount: 0,
				hasRemoteComments: false,
				remoteCommentsCount: 0,
				currentCommit: "abc123",
				hasNewCommits: true,
			};

			const actions = stateManager.getAvailableActions(state);

			expect(actions).toContain("refresh_context");
			expect(actions).not.toContain("gather_context");
		});

		it("should always include run_review and exit", () => {
			const state = {
				hasContext: false,
				contextUpToDate: false,
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

			const actions = stateManager.getAvailableActions(state);

			expect(actions).toContain("run_review");
			expect(actions).toContain("exit");
		});

		it("should include handle_pending only when there are pending comments", () => {
			const stateWithPending = {
				hasContext: true,
				contextUpToDate: true,
				hasComments: true,
				pendingCount: 3,
				acceptedCount: 0,
				fixedCount: 0,
				rejectedCount: 0,
				hasRemoteComments: false,
				remoteCommentsCount: 0,
				currentCommit: "abc123",
				hasNewCommits: false,
			};

			const stateWithoutPending = {
				...stateWithPending,
				pendingCount: 0,
			};

			expect(stateManager.getAvailableActions(stateWithPending)).toContain(
				"handle_pending",
			);
			expect(
				stateManager.getAvailableActions(stateWithoutPending),
			).not.toContain("handle_pending");
		});

		it("should include send_accepted only when there are accepted comments", () => {
			const stateWithAccepted = {
				hasContext: true,
				contextUpToDate: true,
				hasComments: true,
				pendingCount: 0,
				acceptedCount: 2,
				fixedCount: 0,
				rejectedCount: 0,
				hasRemoteComments: false,
				remoteCommentsCount: 0,
				currentCommit: "abc123",
				hasNewCommits: false,
			};

			const stateWithoutAccepted = {
				...stateWithAccepted,
				acceptedCount: 0,
			};

			expect(stateManager.getAvailableActions(stateWithAccepted)).toContain(
				"send_accepted",
			);
			expect(
				stateManager.getAvailableActions(stateWithoutAccepted),
			).not.toContain("send_accepted");
		});
	});

	describe("generateMenuOptions", () => {
		it("should mark gather_context as recommended when no context exists", () => {
			const state = {
				hasContext: false,
				contextUpToDate: false,
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

			const actions = stateManager.getAvailableActions(state);
			const options = stateManager.generateMenuOptions(state, actions);

			const gatherOption = options.find((o) => o.value === "gather_context");
			expect(gatherOption).toBeDefined();
			expect(gatherOption?.recommended).toBe(true);
		});

		it("should add warning hint to run_review when no context exists", () => {
			const state = {
				hasContext: false,
				contextUpToDate: false,
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

			const actions = stateManager.getAvailableActions(state);
			const options = stateManager.generateMenuOptions(state, actions);

			const reviewOption = options.find((o) => o.value === "run_review");
			expect(reviewOption?.warningHint).toBe("No context available");
			expect(reviewOption?.hint).toContain("⚠");
		});

		it("should mark run_review as recommended when context is up-to-date and no comments exist", () => {
			const state = {
				hasContext: true,
				contextUpToDate: true,
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

			const actions = stateManager.getAvailableActions(state);
			const options = stateManager.generateMenuOptions(state, actions);

			const reviewOption = options.find((o) => o.value === "run_review");
			expect(reviewOption?.recommended).toBe(true);
		});

		it("should include comment counts in labels", () => {
			const state = {
				hasContext: true,
				contextUpToDate: true,
				hasComments: true,
				pendingCount: 5,
				acceptedCount: 3,
				fixedCount: 0,
				rejectedCount: 0,
				hasRemoteComments: false,
				remoteCommentsCount: 0,
				currentCommit: "abc123",
				hasNewCommits: false,
			};

			const actions = stateManager.getAvailableActions(state);
			const options = stateManager.generateMenuOptions(state, actions);

			const pendingOption = options.find((o) => o.value === "handle_pending");
			const acceptedOption = options.find((o) => o.value === "send_accepted");

			expect(pendingOption?.label).toContain("5 Pending Comments");
			expect(acceptedOption?.label).toContain("3 Accepted Comments");
		});

		it("should use singular form for single comment", () => {
			const state = {
				hasContext: true,
				contextUpToDate: true,
				hasComments: true,
				pendingCount: 1,
				acceptedCount: 1,
				fixedCount: 0,
				rejectedCount: 0,
				hasRemoteComments: false,
				remoteCommentsCount: 0,
				currentCommit: "abc123",
				hasNewCommits: false,
			};

			const actions = stateManager.getAvailableActions(state);
			const options = stateManager.generateMenuOptions(state, actions);

			const pendingOption = options.find((o) => o.value === "handle_pending");
			const acceptedOption = options.find((o) => o.value === "send_accepted");

			expect(pendingOption?.label).toContain("1 Pending Comment");
			expect(acceptedOption?.label).toContain("1 Accepted Comment");
		});

		it("should show commit hash in refresh context hint", () => {
			const state = {
				hasContext: true,
				contextUpToDate: false,
				contextMeta: {
					gatheredAt: new Date(),
					gatheredFromCommit: "old123commit456",
				},
				hasComments: false,
				pendingCount: 0,
				acceptedCount: 0,
				fixedCount: 0,
				rejectedCount: 0,
				hasRemoteComments: false,
				remoteCommentsCount: 0,
				currentCommit: "abc123",
				hasNewCommits: true,
			};

			const actions = stateManager.getAvailableActions(state);
			const options = stateManager.generateMenuOptions(state, actions);

			const refreshOption = options.find((o) => o.value === "refresh_context");
			expect(refreshOption?.hint).toContain("old123co"); // First 8 chars
		});
	});
});
