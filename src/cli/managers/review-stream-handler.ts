import type LocalCache from "../../cache/local-cache";
import type { PullRequest } from "../../providers/types";
import type { ReviewService } from "../../review/review-service";
import {
	type ContextEvent,
	isContextEvent,
	isReviewEvent,
	type ReviewEvent,
} from "../../review/types";
import type { UILogger } from "../../ui/logger";
import { theme } from "../../ui/theme";
import { promptForCacheStrategy } from "../cli-prompts";
import type { CommentResolutionManager } from "./comment-resolution-manager";

enum Phase {
	INIT = "init",
	CONTEXT = "context",
	REVIEW = "review",
	COMPLETE = "complete",
}

export class ReviewStreamHandler {
	constructor(
		private reviewService: ReviewService,
		private cache: LocalCache,
		private ui: UILogger,
		private commentResolution: CommentResolutionManager,
	) {}

	public async determineCacheStrategy(pr: PullRequest): Promise<{
		gatherContext: boolean;
		refreshCache: boolean;
	}> {
		const cacheInput = {
			sourceBranch: pr.source.name,
			targetBranch: pr.target.name,
		};
		const hasCached = this.cache.has(cacheInput);
		const meta = hasCached ? this.cache.getMetadata(cacheInput) : undefined;

		const { gatherContext, refreshCache } = await promptForCacheStrategy(
			hasCached,
			meta || undefined,
			pr.source.commitHash,
		);

		return { gatherContext, refreshCache };
	}

	public async processReviewStream(
		pr: PullRequest,
		commitMessages: string[],
		fullDiff: string,
		editedFiles: string[],
		cacheConfig: {
			gatherContext: boolean;
			refreshCache: boolean;
		},
	): Promise<{ contextHasError: boolean; reviewHasError: boolean }> {
		const currentPhase = { value: Phase.INIT };
		const contextSpinner = this.ui.spinner();
		const reviewSpinner = this.ui.spinner();
		const contextHasError = { value: false };
		const reviewHasError = { value: false };
		const toolsByType = new Map<string, number>();

		// Get cached context if not gathering/refreshing
		let context: string | undefined;
		if (!cacheConfig.gatherContext && !cacheConfig.refreshCache) {
			const cacheInput = {
				sourceBranch: pr.source.name,
				targetBranch: pr.target.name,
			};
			context = this.cache.get(cacheInput) || undefined;
		}

		const events = this.reviewService.streamReview({
			commits: commitMessages,
			title: pr.title,
			description: pr.description || "",
			editedFiles,
			sourceHash: pr.source.commitHash,
			sourceName: pr.source.name,
			targetHash: pr.target.commitHash,
			targetName: pr.target.name,
			diff: fullDiff,
			context,
			...cacheConfig,
		});

		for await (const event of events) {
			if ("type" in event) {
				const eventContext = {
					currentPhase,
					Phase,
					contextSpinner,
					reviewSpinner,
					contextHasError,
					reviewHasError,
					toolsByType,
				};

				if (isContextEvent(event)) {
					this.handleContextEvent(event, eventContext);
				} else if (isReviewEvent(event)) {
					await this.handleReviewEvent(event, eventContext);
				}
			}
		}

		return {
			contextHasError: contextHasError.value,
			reviewHasError: reviewHasError.value,
		};
	}

	private handleContextEvent(
		event: ContextEvent,
		context: {
			currentPhase: { value: Phase };
			Phase: typeof Phase;
			contextSpinner: ReturnType<UILogger["spinner"]>;
			contextHasError: { value: boolean };
			toolsByType: Map<string, number>;
		},
	): void {
		const {
			currentPhase,
			Phase,
			contextSpinner,
			contextHasError,
			toolsByType,
		} = context;

		switch (event.type) {
			case "context_start":
				currentPhase.value = Phase.CONTEXT;
				this.ui.section("Deep Context Gathering");
				contextSpinner.start(
					theme.accent("Gathering deep context from pull request metadata"),
				);
				break;

			case "context_tool_result":
				if (contextHasError.value) {
					break;
				}
				contextSpinner.message(theme.secondary("Thinking"));
				break;

			case "context_thinking":
				// Reserved for future token streaming
				break;

			case "context_tool_call": {
				if (contextHasError.value) {
					break;
				}

				const count = toolsByType.get(event.toolName) || 0;
				toolsByType.set(event.toolName, count + 1);

				const displayMessage = this.getContextToolMessage(
					event.toolName,
					event.input,
				);
				const spinnerMessage = displayMessage.split(" ", 1)[0];
				this.ui.info(displayMessage);
				contextSpinner.message(theme.secondary(spinnerMessage));
				break;
			}

			case "context_tool_call_reasoning":
				this.ui.step(event.message);
				break;

			case "context_success":
				if (currentPhase.value === Phase.CONTEXT && !contextHasError.value) {
					const message =
						event.dataSource === "cache"
							? "Using cached deep context"
							: `Context gathered using ${toolsByType.size} tool call(s)`;
					contextSpinner.stop(theme.success(`✓ ${message}`));
				}
				break;

			case "context_error":
				contextHasError.value = true;
				contextSpinner.stop(theme.error("✗ Context gathering failed"));
				this.ui.error(event.message);
				this.ui.warn("Proceeding with review using limited context");
				break;

			case "context_data":
				this.cache.set(
					{
						sourceBranch: event.data.sourceBranch,
						targetBranch: event.data.targetBranch,
						currentCommit: event.data.currentCommit,
					},
					event.data.context,
				);
				break;
		}
	}

	private async handleReviewEvent(
		event: ReviewEvent,
		context: {
			currentPhase: { value: Phase };
			Phase: typeof Phase;
			reviewSpinner: ReturnType<UILogger["spinner"]>;
			reviewHasError: { value: boolean };
			contextHasError: { value: boolean };
			toolsByType: Map<string, number>;
		},
	): Promise<void> {
		const {
			currentPhase,
			Phase,
			reviewSpinner,
			reviewHasError,
			contextHasError,
			toolsByType,
		} = context;

		switch (event.type) {
			case "review_start":
				if (currentPhase.value === Phase.CONTEXT) {
					this.ui.sectionComplete("Deep context synthesis complete");
					currentPhase.value = Phase.REVIEW;
				}

				if (contextHasError.value) {
					this.ui.warn("Starting review with degraded context");
				}

				this.ui.section("Code Review Analysis");
				reviewSpinner.start(
					theme.accent("Initializing Claude Code in read-only mode"),
				);
				break;

			case "review_thinking": {
				if (reviewHasError.value) {
					break;
				}

				const text = event.text.trim();
				// Show substantial thinking as a step (like context reasoning)
				if (text.length > 20) {
					this.ui.step(text);
				}
				break;
			}

			case "review_tool_call": {
				if (reviewHasError.value) {
					break;
				}

				const count = toolsByType.get(event.toolName) || 0;
				toolsByType.set(event.toolName, count + 1);

				const displayMessage = this.getReviewToolMessage(
					event.toolName,
					event.input,
				);
				const spinnerMessage = displayMessage.split(" ", 1)[0];
				this.ui.info(displayMessage);
				reviewSpinner.message(theme.secondary(spinnerMessage));
				break;
			}

			case "review_tool_result":
				if (reviewHasError.value) {
					break;
				}
				reviewSpinner.message(theme.secondary("Analyzing"));
				break;

			case "review_success":
				if (currentPhase.value === Phase.REVIEW && !reviewHasError.value) {
					const commentLabel =
						event.commentCount === 1 ? "comment" : "comments";
					reviewSpinner.stop(
						theme.success(`✓ ${event.commentCount} ${commentLabel} found`),
					);
					this.ui.sectionComplete("Analysis complete");
					currentPhase.value = Phase.COMPLETE;
				}
				break;

			case "review_data": {
				const prKey = `${event.data.sourceBranch}|${event.data.targetBranch}`;
				await this.commentResolution.saveCommentsToCache(
					event.data.comments,
					prKey,
				);
				break;
			}

			case "review_error":
				reviewHasError.value = true;
				reviewSpinner.stop(theme.error("✗ Review failed"));
				this.ui.error(event.message);
				break;
		}
	}

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

	private getReviewToolMessage(toolName: string, arg?: string): string {
		const messages: Record<string, string> = {
			Read: `📖 Reading ${arg || "file"}`,
			Grep: `🔍 Searching for pattern${arg ? `: ${arg}` : ""}`,
			Glob: `📁 Finding files${arg ? `: ${arg}` : ""}`,
		};
		return messages[toolName] || `⚡ ${toolName}${arg ? `: ${arg}` : ""}`;
	}
}
