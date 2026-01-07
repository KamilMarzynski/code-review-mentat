import * as clack from "@clack/prompts";
import type LocalCache from "../cache/local-cache";
import type GitOperations from "../git/operations";
import type { GitProvider, PullRequest } from "../providers/types";
import type { ReviewService } from "../review/review-service";
import {
	type ContextEvent,
	isContextEvent,
	isReviewEvent,
	type ReviewEvent,
} from "../review/types";
import type { UILogger } from "../ui/logger";
import { theme } from "../ui/theme";
import { displayComments, displayContext, displayHeader } from "./display";
import {
	promptForCacheStrategy,
	promptForPR,
	promptForRemote,
} from "./prompts";

enum Phase {
	INIT = "init",
	CONTEXT = "context",
	REVIEW = "review",
	COMPLETE = "complete",
}

export class CLIOrchestrator {
	constructor(
		private git: GitOperations,
		private createProvider: (remote: string) => GitProvider,
		private reviewService: ReviewService,
		private cache: LocalCache,
		private ui: UILogger,
	) {}

	public async run(): Promise<void> {
		displayHeader();
		clack.intro(theme.primary("Initiating Mentat analysis protocol..."));

		const currentBranch = await this.git.getCurrentBranch();
		const { cleanup } = this.setupCleanupHandlers(currentBranch);

		try {
			// Step 1-2: Remote selection and PR fetching
			const selectedRemote = await this.selectRemote();
			const { provider, prs } = await this.fetchPullRequests(selectedRemote);

			// Step 3: PR selection
			const selectedPr = await this.selectPullRequest(prs);

			// Step 4: Repository preparation
			await this.prepareRepository(selectedRemote, selectedPr);

			// Step 5: Changes analysis
			const { fullDiff, editedFiles } = await this.analyzeChanges(selectedPr);

			// Step 6: Commit history
			const commitMessages = await this.fetchCommitHistory(
				provider,
				selectedPr,
			);

			// Step 7: Cache strategy
			const cacheConfig = await this.determineCacheStrategy(selectedPr);

			// Step 8: Process review stream
			const { contextHasError, reviewHasError } =
				await this.processReviewStream(
					selectedPr,
					commitMessages,
					fullDiff,
					editedFiles,
					cacheConfig,
				);

			console.log(""); // Spacing

			if (contextHasError || reviewHasError) {
				clack.outro(
					theme.warning("⚠ Mentat completed with errors. ") +
						theme.muted("Please review the output carefully."),
				);
			} else {
				clack.outro(
					theme.primary("⚡ Mentat computation complete. ") +
						theme.muted("The analysis is now in your hands."),
				);
			}
		} catch (error) {
			clack.cancel(
				theme.error("✗ Mentat encountered an error:\n") +
					theme.muted(`   ${(error as Error).message}`),
			);
			throw error;
		} finally {
			// Remove signal handlers to prevent double cleanup
			process.removeAllListeners("SIGINT");
			process.removeAllListeners("SIGTERM");

			// Always restore branch (for normal exit)
			await cleanup();
		}
	}

	private setupCleanupHandlers(currentBranch: string): {
		cleanup: (signal?: string) => Promise<void>;
		cleanupDone: { value: boolean };
	} {
		const cleanupDone = { value: false };

		const cleanup = async (signal?: string) => {
			if (cleanupDone.value) {
				return;
			}
			cleanupDone.value = true;

			try {
				console.log(""); // Ensure clean line
				const s = this.ui.spinner();
				s.start(theme.muted(`Restoring original state (${currentBranch})...`));
				await this.git.checkout(currentBranch);
				s.stop(theme.success("✓ Repository state restored"));

				if (signal) {
					clack.outro(theme.warning(`⚠ Process interrupted (${signal})`));
				}
			} catch (error) {
				console.error(error);
				clack.log.error(
					theme.error("⚠ Failed to restore branch state\n") +
						theme.muted(
							`   Please manually run: git checkout ${currentBranch}`,
						),
				);
			} finally {
				if (signal) {
					process.exit(130); // 130 is standard exit code for SIGINT
				}
			}
		};

		const signalHandler = (signal: string) => {
			cleanup(signal).catch(() => process.exit(1));
		};

		process.on("SIGINT", () => signalHandler("SIGINT"));
		process.on("SIGTERM", () => signalHandler("SIGTERM"));

		return { cleanup, cleanupDone };
	}

	private async selectRemote(): Promise<string> {
		const s1 = this.ui.spinner();
		s1.start(theme.muted("Scanning git remotes"));

		const allRemotes = await this.git.getRemotes();
		s1.stop(theme.success(`✓ Found ${allRemotes.length} remote(s)`));

		return promptForRemote(allRemotes);
	}

	private async fetchPullRequests(
		remote: string,
	): Promise<{ provider: GitProvider; prs: PullRequest[] }> {
		const s2 = this.ui.spinner();
		s2.start(theme.muted("Querying pull requests from remote"));

		const provider = this.createProvider(remote);
		const prs = await provider.fetchPullRequests();

		s2.stop(theme.success(`✓ Retrieved ${prs.length} pull request(s)`));

		if (prs.length === 0) {
			clack.outro(theme.warning("No pull requests found. Mentat standing by."));
			process.exit(0);
		}

		return { provider, prs };
	}

	private async selectPullRequest(prs: PullRequest[]): Promise<PullRequest> {
		const selectedPr = await promptForPR(prs);

		clack.log.step(theme.muted(`Target: ${selectedPr.title}`));
		clack.log.step(
			theme.muted(
				`Source: ${selectedPr.source.name} (${selectedPr.source.commitHash.substring(0, 8)})`,
			),
		);
		clack.log.step(
			theme.muted(
				`Target: ${selectedPr.target.name} (${selectedPr.target.commitHash.substring(0, 8)})`,
			),
		);

		return selectedPr;
	}

	private async prepareRepository(
		remote: string,
		pr: PullRequest,
	): Promise<void> {
		const s3 = this.ui.spinner();
		s3.start(theme.muted("Synchronizing repository state"));

		try {
			s3.message(theme.muted("Fetching PR branches"));
			await this.git.fetch(remote, pr.source.name);
			await this.git.fetch(remote, pr.target.name);

			s3.message(
				theme.muted("Entering computation state (checking out source)"),
			);
			await this.git.checkout(pr.source.commitHash);

			s3.stop(theme.success("✓ Repository prepared"));
		} catch (error) {
			s3.stop(theme.error("✗ Repository synchronization failed"));
			this.ui.error(
				`Failed to prepare repository: ${(error as Error).message}`,
			);
			this.ui.info(`Try running: git fetch ${remote} ${pr.source.name}`);
			throw error;
		}
	}

	private async analyzeChanges(
		pr: PullRequest,
	): Promise<{ fullDiff: string; editedFiles: string[] }> {
		const s4 = this.ui.spinner();
		s4.start(theme.muted("Computing diff matrix"));

		const fullDiff = await this.git.getDiff(
			pr.target.commitHash,
			pr.source.commitHash,
		);
		const editedFiles = await this.git.getDiffSummary(
			pr.target.commitHash,
			pr.source.commitHash,
		);

		s4.stop(theme.success(`✓ Analyzed ${editedFiles.length} file(s)`));

		clack.log.info(
			theme.muted("Modified files: ") +
				theme.secondary(editedFiles.slice(0, 5).join(", ")) +
				(editedFiles.length > 5
					? theme.muted(` (+${editedFiles.length - 5} more)`)
					: ""),
		);

		return { fullDiff, editedFiles };
	}

	private async fetchCommitHistory(
		provider: GitProvider,
		pr: PullRequest,
	): Promise<string[]> {
		const s5 = this.ui.spinner();
		s5.start(theme.muted("Retrieving commit chronology"));

		const commitMessages = await provider.fetchCommits(pr);
		s5.stop(theme.success(`✓ Processed ${commitMessages.length} commit(s)`));

		console.log(""); // Spacing
		return commitMessages;
	}

	private async determineCacheStrategy(pr: PullRequest): Promise<{
		gatherContext: boolean;
		refreshCache: boolean;
		context?: string;
	}> {
		const cacheInput = {
			sourceBranch: pr.source.name,
			targetBranch: pr.target.name,
		};
		const hasCached = this.cache.has(cacheInput);
		const meta = hasCached ? this.cache.getMetadata(cacheInput) : undefined;

		let context: string | undefined;
		if (hasCached && meta) {
			context = this.cache.get(cacheInput) || undefined;
		}

		const { gatherContext, refreshCache } = await promptForCacheStrategy(
			hasCached,
			meta || undefined,
			pr.source.commitHash,
		);

		return { gatherContext, refreshCache, context };
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

	private handleReviewEvent(
		event: ReviewEvent,
		context: {
			currentPhase: { value: Phase };
			Phase: typeof Phase;
			reviewSpinner: ReturnType<UILogger["spinner"]>;
			reviewHasError: { value: boolean };
			contextHasError: { value: boolean };
			toolsByType: Map<string, number>;
		},
	): void {
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
				if (text.length > 10 && text.length < 100) {
					const display =
						text.length > 70 ? text.substring(0, 70) + "..." : text;
					reviewSpinner.message(theme.dim(`💭 ${display}`));
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
					const message = `Review complete: ${event.commentCount} observation(s)`;
					reviewSpinner.stop(theme.success(`✓ ${message}`));
					this.ui.sectionComplete("Analysis complete");
					currentPhase.value = Phase.COMPLETE;
				}
				break;

			case "review_data":
				// TODO: Put comments in cache
				break;

			case "review_error":
				reviewHasError.value = true;
				reviewSpinner.stop(theme.error("✗ Review failed"));
				this.ui.error(event.message);
				break;
		}
	}

	private async processReviewStream(
		pr: PullRequest,
		commitMessages: string[],
		fullDiff: string,
		editedFiles: string[],
		cacheConfig: {
			gatherContext: boolean;
			refreshCache: boolean;
			context?: string;
		},
	): Promise<{ contextHasError: boolean; reviewHasError: boolean }> {
		enum Phase {
			INIT = "init",
			CONTEXT = "context",
			REVIEW = "review",
			COMPLETE = "complete",
		}

		const currentPhase = { value: Phase.INIT };
		const contextSpinner = this.ui.spinner();
		const reviewSpinner = this.ui.spinner();
		const contextHasError = { value: false };
		const reviewHasError = { value: false };
		const toolsByType = new Map<string, number>();

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
					this.handleReviewEvent(event, eventContext);
				}
			} else {
				console.log(""); // Spacing
				displayContext(event.context);
				displayComments(event.comments);
			}
		}

		return {
			contextHasError: contextHasError.value,
			reviewHasError: reviewHasError.value,
		};
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
