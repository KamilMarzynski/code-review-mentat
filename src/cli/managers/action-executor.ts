import type LocalCache from "../../cache/local-cache";
import { getPRKey, type PullRequest } from "../../git-providers/types";
import type { MemoryService } from "../../memory/memory-service";
import type { MemoryQueryGenerator } from "../../memory/query-generator";
import type { CodeReviewer } from "../../review/code-reviewer";
import type { ContextGatherer } from "../../review/context-gatherer";
import type { ContextGathererFactory } from "../../review/context-gatherer-factory";
import type { ContextEvent, ReviewEvent } from "../../review/types";
import { ui } from "../../ui/logger";
import { theme } from "../../ui/theme";
import {
	promptToResolveComments,
	promptToSendCommentsToRemote,
} from "../cli-prompts";
import type { HandleCommentsResult, ReviewResult } from "../types";
import type { CommentDisplayService } from "./comment-display-service";
import type { CommentResolutionManager } from "./comment-resolution-manager";
import type { FixSessionOrchestrator } from "./fix-session-orchestrator";
import type { PostCommentResult, PRWorkflowManager } from "./pr-workflow-manager";

/**
 * Centralized execution of workflow actions
 *
 * Responsibilities:
 * - Execute context gathering (with cache management)
 * - Execute review process
 * - Execute pending comment handling
 * - Execute sending accepted comments to remote
 *
 * Each method is self-contained and returns structured result objects
 * for use by the orchestrator or post-action handlers.
 */
type PRMetadata = {
	prKey: string;
	commits: string[];
	fullDiff: string;
	editedFiles: string[];
};

export class ActionExecutor {
	private contextGatherer: ContextGatherer | null = null;
	private prMetadataCache: PRMetadata | null = null;

	constructor(
		private prWorkflow: PRWorkflowManager,
		private commentResolution: CommentResolutionManager,
		private fixSession: FixSessionOrchestrator,
		private commentDisplay: CommentDisplayService,
		private contextGathererFactory: ContextGathererFactory,
		private codeReviewer: CodeReviewer,
		private cache: LocalCache,
		private memoryService: MemoryService,
		private memoryQueryGenerator: MemoryQueryGenerator,
	) {}

	/**
	 * Fetch PR metadata (commits, diff, edited files) with per-PR memoization.
	 * Avoids redundant git operations when multiple methods need the same data.
	 */
	private async getPRMetadata(pr: PullRequest): Promise<PRMetadata> {
		const prKey = getPRKey(pr);
		if (this.prMetadataCache?.prKey === prKey) {
			return this.prMetadataCache;
		}
		const commits = await this.prWorkflow.fetchCommitHistory(pr);
		const { fullDiff, editedFiles } = await this.prWorkflow.analyzeChanges(pr);
		this.prMetadataCache = { prKey, commits, fullDiff, editedFiles };
		return this.prMetadataCache;
	}

	/**
	 * Execute context gathering for a pull request
	 *
	 * @param pr - Pull request to gather context for
	 * @param refresh - Whether to refresh existing context
	 */
	async executeGatherContext(pr: PullRequest): Promise<void> {
		const spinner = ui.spinner();
		const toolsByType = new Map<string, number>();
		let hasError = false;
		let spinnerStarted = false;

		try {
			// Lazy initialization of context gatherer
			if (!this.contextGatherer) {
				this.contextGatherer = await this.contextGathererFactory.create();
			}

			// Fetch commit history and edited files
			const { commits, editedFiles } = await this.getPRMetadata(pr);

			const contextInput = {
				commits,
				title: pr.title,
				description: pr.description,
				editedFiles,
				sourceBranch: pr.source.name,
				targetBranch: pr.target.name,
				sourceHash: pr.source.commitHash,
			};

			ui.section("Deep Context Gathering");
			spinner.start(
				theme.accent("Gathering deep context from pull request metadata"),
			);
			spinnerStarted = true;

			// Stream context gathering events
			for await (const event of this.contextGatherer.gather(contextInput)) {
				// Check if this is a context event
				if ("type" in event) {
					const contextEvent = event as ContextEvent;

					switch (contextEvent.type) {
						case "context_tool_call": {
							if (hasError) {
								break;
							}

							const count = toolsByType.get(contextEvent.toolName) || 0;
							toolsByType.set(contextEvent.toolName, count + 1);

							const displayMessage = this.getContextToolMessage(
								contextEvent.toolName,
								contextEvent.input,
							);
							const spinnerMessage = this.extractSpinnerMessage(displayMessage);
							ui.info(displayMessage);
							spinner.message(theme.secondary(spinnerMessage));
							break;
						}

						case "context_tool_call_reasoning":
							ui.step(contextEvent.message);
							break;

						case "context_tool_result":
							if (!hasError) {
								spinner.message(theme.secondary("Thinking"));
							}
							break;

						case "context_success":
							if (!hasError) {
								spinner.stop(
									theme.success("✓ Deep context synthesis complete"),
								);
								spinnerStarted = false;
							}
							break;

						case "context_error":
							hasError = true;
							spinner.stop(theme.error("✗ Context gathering failed"));
							spinnerStarted = false;
							ui.error(contextEvent.message);
							break;

						case "context_data":
							// Save to cache
							this.cache.set(
								{
									sourceBranch: contextEvent.data.sourceBranch,
									targetBranch: contextEvent.data.targetBranch,
									currentCommit: contextEvent.data.currentCommit,
								},
								contextEvent.data.context,
							);
							break;
					}
				}
			}

			if (!hasError && spinnerStarted) {
				spinner.stop(theme.success("✓ Context gathered successfully"));
				spinnerStarted = false;
			}
		} catch (error) {
			if (spinnerStarted) {
				spinner.stop(theme.error("✗ Context gathering failed"));
			}
			ui.error(
				theme.error("✗ Context gathering failed:\n") +
					theme.muted(`   ${(error as Error).message}`),
			);
		}
	}

	/**
	 * Retrieve past review memories from vector database
	 *
	 * Short-circuits if memories already cached for this PR.
	 * Generates search queries via LLM, then searches vector DB.
	 */
	async executeRetrieveMemories(pr: PullRequest): Promise<void> {
		const cacheInput = {
			sourceBranch: pr.source.name,
			targetBranch: pr.target.name,
		};

		// Short-circuit if memories already cached
		const cached = this.cache.getMemories(cacheInput);
		if (cached !== null) {
			if (cached.length > 0) {
				ui.info(
					theme.muted(
						`Using ${cached.length} cached memory/memories from previous retrieval`,
					),
				);
			}
			return;
		}

		const spinner = ui.spinner();

		try {
			spinner.start(theme.accent("Retrieving past review memories"));

			// Fetch PR metadata for query generation (memoized)
			const { commits, fullDiff, editedFiles } = await this.getPRMetadata(pr);

			// Load context from cache (may be null if user skipped context gathering)
			const cachedContext = this.cache.get(cacheInput);

			// Fetch example situations for query calibration
			const exampleSituations = this.memoryService.getRandomSituations(5);

			// Generate search queries via LLM
			const queries = await this.memoryQueryGenerator.generateQueries({
				context: cachedContext ?? undefined,
				editedFiles,
				commits,
				diff: fullDiff,
				sourceBranch: pr.source.name,
				targetBranch: pr.target.name,
				exampleSituations,
			});

			// Search vector database
			const memories = await this.memoryService.searchMemories(queries, {
				maxDistance: 0.8,
				limit: 10,
			});

			// Cache results (even if empty, to prevent re-querying)
			const saved = this.cache.saveMemories(cacheInput, memories);
			if (!saved) {
				ui.info(
					theme.muted("Could not cache memories (no cache file for this PR)"),
				);
			}

			if (memories.length > 0) {
				spinner.stop(
					theme.success(
						`✓ Found ${memories.length} relevant memory/memories from past reviews`,
					),
				);
				for (const memory of memories) {
					ui.info(
						theme.secondary(`  [${memory.severity}] ${memory.situation}`),
					);
					ui.info(theme.muted(`    Lesson: ${memory.lesson}`));
					ui.info(theme.muted(`    Distance: ${memory.distance.toFixed(3)}`));
				}
			} else {
				spinner.stop(
					theme.muted("No relevant memories found from past reviews"),
				);
			}
		} catch (error) {
			spinner.stop(
				theme.warning(
					"⚠ Memory retrieval failed (continuing without memories)",
				),
			);
			ui.info(theme.muted(`   ${(error as Error).message}`));

			// Do not cache on failure — allow retry on next attempt
		}
	}

	/**
	 * Extract a clean spinner message from a display message
	 * Removes emojis and extracts the action phrase
	 */
	private extractSpinnerMessage(displayMessage: string): string {
		// Remove emoji characters using regex (matches most emoji ranges)
		const withoutEmoji = displayMessage.replace(
			/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
			"",
		);

		// Trim and take the part before any colon (the action, not the details)
		const action = withoutEmoji.split(":")[0]?.trim() ?? "";

		// If we got something meaningful, use it; otherwise use the cleaned message
		return action.length > 0 ? action : withoutEmoji.trim();
	}

	/**
	 * Get display message for context gathering tool calls
	 */
	private getContextToolMessage(toolName: string, arg?: string): string {
		const messages: Record<string, string> = {
			search: `🔍 Searching Jira${arg ? `: "${arg}"` : ""}`,
			getIssue: `📋 Fetching issue${arg ? ` ${arg}` : ""}`,
			getJiraIssue: `📋 Fetching issue${arg ? ` ${arg}` : ""}`,
			searchConfluencePages: `📚 Searching Confluence${arg ? `: "${arg}"` : ""}`,
			getConfluencePage: `📄 Reading page${arg ? ` ${arg}` : ""}`,
			fetch: `📡 Fetching resource${arg ? `: ${arg}` : ""}`,
			getAccessibleAtlassianResources: `🌐 Listing accessible resources${arg ? `: ${arg}` : ""}`,
		};
		return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ""}`;
	}

	/**
	 * Execute review process for a pull request
	 *
	 * @param pr - Pull request to review
	 * @param state - Current workflow state
	 * @returns Review result with comment count and error status
	 */
	async executeReview(pr: PullRequest): Promise<ReviewResult> {
		const prKey = getPRKey(pr);
		const spinner = ui.spinner();
		let hasError = false;
		let spinnerStarted = false;

		try {
			// Fetch commit history and changes (memoized)
			const { commits, fullDiff, editedFiles } = await this.getPRMetadata(pr);

			// Load context from cache if available
			const cacheInput = {
				sourceBranch: pr.source.name,
				targetBranch: pr.target.name,
			};
			const cachedContext = this.cache.get(cacheInput);

			// Load memories from cache if available
			const memories = this.cache.getMemories(cacheInput) ?? undefined;

			// Build review input
			const reviewInput = {
				context: cachedContext || undefined,
				memories,
				editedFiles,
				commits,
				diff: fullDiff,
				sourceBranch: pr.source.name,
				targetBranch: pr.target.name,
				sourceHash: pr.source.commitHash,
			};

			ui.section("Code Review Analysis");
			spinner.start(theme.accent("Analyzing pull request changes"));
			spinnerStarted = true;

			// Stream review events
			for await (const event of this.codeReviewer.review(reviewInput)) {
				// Check if this is a review event
				if ("type" in event) {
					const reviewEvent = event as ReviewEvent;

					switch (reviewEvent.type) {
						case "review_start":
							// Already started spinner
							break;

						case "review_thinking":
							if (!hasError) {
								ui.step(reviewEvent.text);
							}
							break;

						case "review_tool_call": {
							if (hasError) break;

							const displayMessage = this.getReviewToolMessage(
								reviewEvent.toolName,
								reviewEvent.input,
							);
							const spinnerMessage = this.extractSpinnerMessage(displayMessage);
							ui.info(displayMessage);
							spinner.message(theme.secondary(spinnerMessage));
							break;
						}

						case "review_tool_result":
							if (!hasError) {
								spinner.message(theme.secondary("Analyzing results"));
							}
							break;

						case "review_success":
							if (!hasError) {
								ui.sectionComplete(
									`Code review complete: ${reviewEvent.commentCount} comment(s) found`,
								);
							}
							break;

						case "review_error":
							hasError = true;
							spinner.stop(theme.error("✗ Review failed"));
							spinnerStarted = false;
							ui.error(reviewEvent.message);
							break;

						case "review_data":
							// Save comments to cache
							await this.commentResolution.saveCommentsToCache(
								reviewEvent.data.comments,
								prKey,
							);
							break;
					}
				}
			}

			if (!hasError && spinnerStarted) {
				spinner.stop(theme.success("✓ Review completed successfully"));
				spinnerStarted = false;
			}

			console.log(""); // Spacing

			// Get comments created by the review
			const comments = await this.cache.getComments(prKey);
			const pendingComments = comments.filter(
				(c) => c.status === "pending" || !c.status,
			);

			// Display review summary if comments exist
			if (comments.length > 0 && !hasError) {
				console.log("");
				console.log(theme.muted("─".repeat(60)));
				this.commentDisplay.displayReviewSummary(comments);
			}

			if (hasError) {
				ui.outro(
					theme.warning("⚠ Computation completed with errors. ") +
						theme.muted("Review the output above for details."),
				);
			} else {
				ui.outro(
					theme.computation("⚡ Computation complete. ") +
						theme.muted("Assessment data synthesized."),
				);
			}

			return {
				commentsCreated: pendingComments.length,
				hasErrors: hasError,
			};
		} catch (error) {
			if (spinnerStarted) {
				spinner.stop(theme.error("✗ Review failed"));
			}
			ui.error(
				theme.error("✗ Review execution failed:\n") +
					theme.muted(`   ${(error as Error).message}`),
			);
			return {
				commentsCreated: 0,
				hasErrors: true,
			};
		}
	}

	/**
	 * Get display message for review tool calls
	 */
	private getReviewToolMessage(toolName: string, arg?: string): string {
		const messages: Record<string, string> = {
			Read: `📖 Reading${arg ? `: ${arg}` : " file"}`,
			Grep: `🔍 Searching${arg ? `: "${arg}"` : " codebase"}`,
			Glob: `📁 Finding files${arg ? `: ${arg}` : ""}`,
		};
		return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ""}`;
	}

	/**
	 * Execute handling of pending comments
	 *
	 * @param pr - Pull request with pending comments
	 * @returns Summary of comment handling results
	 */
	async executeHandlePending(pr: PullRequest): Promise<HandleCommentsResult> {
		const prKey = getPRKey(pr);

		try {
			const result = await this.commentResolution.handleComments(
				prKey,
				async (comment, prKey, interimSummary) => {
					// Get optional notes for Claude
					const optionalNotes = await this.commentDisplay.promptOptionalNotes();

					// Run the fix session (planning + execution)
					await this.fixSession.runFixSession(
						comment,
						prKey,
						optionalNotes,
						interimSummary,
					);
				},
				async (comment) => {
					await this.commentDisplay.displayCommentWithContext(comment);
				},
			);

			return result;
		} catch (error) {
			ui.error(
				theme.error("✗ Comment handling failed:\n") +
					theme.muted(`   ${(error as Error).message}`),
			);
			return {
				processed: 0,
				fixed: 0,
				accepted: 0,
				rejected: 0,
				skipped: 0,
			};
		}
	}

	/**
	 * Execute sending accepted comments to remote PR
	 *
	 * @param pr - Pull request to send comments to
	 * @returns Number of comments successfully posted
	 */
	async executeSendAccepted(pr: PullRequest): Promise<number> {
		const prKey = getPRKey(pr);

		try {
			const comments = await this.cache.getComments(prKey);
			const acceptedComments = comments.filter((c) => c.status === "accepted");

			if (acceptedComments.length === 0) {
				ui.info(theme.muted("No accepted comments to send."));
				return 0;
			}

			const results = await this.prWorkflow.postCommentsToRemote(
				pr,
				acceptedComments,
			);

			let successCount = 0;

			for (const result of results) {
				const location = result.comment.file
					? `${result.comment.file}${result.comment.line ? `:${result.comment.line}` : ""}`
					: "PR discussion";

				if (result.success) {
					await this.cache.updateComment(prKey, result.comment.id, {
						status: "posted",
						remoteCommentId: result.id,
						remoteCommentUrl: result.url,
					});
					ui.success(theme.success(`✓ Posted: ${result.url ?? location}`));
					successCount++;
				} else {
					ui.error(
						theme.error(`✗ Failed to post ${location}: ${result.error}`),
					);
				}
			}

			return successCount;
		} catch (error) {
			ui.error(
				theme.error(
					`✗ Failed to post comments to the pull request: ${(error as Error).message}`,
				),
			);
			return 0;
		}
	}

	/**
	 * Prompt and execute sending accepted comments (legacy support)
	 *
	 * This method combines prompting and execution for backward compatibility.
	 * New code should use executeSendAccepted() directly and handle prompting separately.
	 *
	 * @param pr - Pull request to check and send comments for
	 */
	async promptAndSendAccepted(pr: PullRequest): Promise<void> {
		const prKey = getPRKey(pr);
		const comments = await this.cache.getComments(prKey);
		const acceptedComments = comments.filter((c) => c.status === "accepted");

		if (acceptedComments.length === 0) {
			return;
		}

		const shouldSend = await promptToSendCommentsToRemote();

		if (shouldSend) {
			await this.executeSendAccepted(pr);
		}
	}

	/**
	 * Prompt and execute handling pending comments (legacy support)
	 *
	 * This method combines prompting and execution for backward compatibility.
	 * New code should use executeHandlePending() directly and handle prompting separately.
	 *
	 * @param pr - Pull request to check for pending comments
	 * @returns True if comments were handled
	 */
	async promptAndHandlePending(pr: PullRequest): Promise<boolean> {
		const prKey = getPRKey(pr);
		const comments = await this.cache.getComments(prKey);
		const pendingComments = comments.filter(
			(c) => c.status === "pending" || !c.status,
		);

		if (pendingComments.length === 0) {
			return false;
		}

		console.log("");
		console.log(theme.muted("─".repeat(60)));
		console.log("");

		const shouldResolve = await promptToResolveComments();

		if (!shouldResolve) {
			ui.info(
				theme.muted(
					"Comments are saved. You can review them anytime by running the tool again.",
				),
			);
			return false;
		}

		await this.executeHandlePending(pr);
		return true;
	}
}
