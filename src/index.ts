import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent } from "langchain";
import LocalCache from "./cache/local-cache";
import { ActionExecutor } from "./cli/managers/action-executor";
import { CommentDisplayService } from "./cli/managers/comment-display-service";
import { CommentResolutionManager } from "./cli/managers/comment-resolution-manager";
import { FixSessionOrchestrator } from "./cli/managers/fix-session-orchestrator";
import { PostActionHandler } from "./cli/managers/post-action-handler";
import { PRWorkflowManager } from "./cli/managers/pr-workflow-manager";
import { WorkflowStateManager } from "./cli/managers/workflow-state-manager";
import { CLIOrchestrator } from "./cli/orchestrator";
import GitOperations from "./git/operations";
import BitbucketServerGitProvider from "./git-providers/bitbucket";
import { createMCPClient, getMCPTools } from "./mcp/client";
import { CodeReviewer } from "./review/code-reviewer";
import { CommentFixer } from "./review/comment-fixer";
import { ContextGatherer } from "./review/context-gatherer";
import { UILogger } from "./ui/logger";

const { PATH_TO_CLAUDE } = process.env;
if (!PATH_TO_CLAUDE) {
	throw new Error("PATH_TO_CLAUDE environment variable is not set.");
}

const main = async () => {
	// ============================================================================
	// Dependency Injection Architecture
	// ============================================================================
	// This file orchestrates the creation and wiring of all application dependencies.
	// Dependencies are organized in layers:
	//
	// 1. Infrastructure Layer (Singletons)
	//    - git: GitOperations
	//    - cache: LocalCache
	//    - ui: UILogger
	//    - model: ChatAnthropic (LangChain)
	//
	// 2. Service Layer
	//    - Context: ContextGatherer, CodeReviewer, ReviewService
	//    - Comments: CommentFixer, CommentResolutionManager, CommentDisplayService
	//    - Workflow: PRWorkflowManager
	//
	// 3. Manager Layer (Orchestration)
	//    - WorkflowStateManager: State detection
	//    - ActionExecutor: Action execution
	//    - PostActionHandler: Smart flow transitions
	//    - ReviewStreamHandler: Review coordination
	//    - FixSessionOrchestrator: Fix workflow
	//
	// 4. Orchestrator Layer
	//    - CLIOrchestrator: Main entry point with menu-driven workflow
	// ============================================================================

	// Start MCP initialization in background (don't await yet)
	const mcpInitPromise = (async () => {
		const mcpClient = createMCPClient();
		const tools = await getMCPTools(mcpClient);
		return { mcpClient, tools };
	})();

	// ============================================================================
	// Infrastructure Services (Singleton Pattern)
	// ============================================================================
	const git = new GitOperations();
	const cache = new LocalCache();
	const ui = new UILogger();

	// Initialize LangChain model
	const model = new ChatAnthropic({
		model: "claude-sonnet-4-5-20250929",
		temperature: 0,
	});

	// ============================================================================
	// Service Layer
	// ============================================================================
	// Factory function to lazily create context gatherer when needed
	const createContextGatherer = async () => {
		const { tools } = await mcpInitPromise;
		const contextGathererAgent = createAgent({
			model,
			tools,
			systemPrompt: `You are a code review context specialist.

## Your Goal
Gather ONLY information that will help an AI perform code review. Focus on:
1. Business requirements from Jira tickets
2. Technical specifications from Confluence
3. Related architectural decisions

## Process
1. Extract ticket references from PR title, description, and commits (e.g., PROJ-123)
2. Fetch each ticket and summarize acceptance criteria
3. Search Confluence for related technical documentation
4. Synthesize findings into actionable context

## Output Format
Provide a structured summary:
- **Requirements**: What the PR should accomplish
- **Technical Context**: Relevant architecture/patterns
- **Edge Cases**: Known constraints or special handling

## Constraints
- Skip information already in the PR description
- Focus on REQUIREMENTS, not implementation details`,
		});
		return new ContextGatherer(contextGathererAgent);
	};

	// Initialize review services
	const codeReviewer = new CodeReviewer(PATH_TO_CLAUDE);
	const commentFixer = new CommentFixer(PATH_TO_CLAUDE);

	// Provider factory function
	const createProvider = (remote: string) =>
		new BitbucketServerGitProvider(remote);

	const prWorkflow = new PRWorkflowManager(git, createProvider, ui);
	const commentResolution = new CommentResolutionManager(cache, ui);

	const fixSession = new FixSessionOrchestrator(commentFixer, git, cache, ui);
	const commentDisplay = new CommentDisplayService(ui);

	// ============================================================================
	// Manager Layer (Menu-Driven Workflow Architecture)
	// ============================================================================
	// These managers implement the menu-driven state machine:
	// - WorkflowStateManager: Detects current state and generates menu options
	// - ActionExecutor: Executes user-selected actions
	// - PostActionHandler: Provides smart flow transitions after actions
	// ============================================================================
	const stateManager = new WorkflowStateManager(cache);
	const contextGatherer = await createContextGatherer();
	const actionExecutor = new ActionExecutor(
		prWorkflow,
		commentResolution,
		fixSession,
		commentDisplay,
		contextGatherer,
		codeReviewer,
		cache,
	);
	const postActionHandler = new PostActionHandler(stateManager);

	// ============================================================================
	// Orchestrator Layer
	// ============================================================================
	// CLIOrchestrator is the main entry point:
	// - Handles initial setup (workspace check, PR selection, repo preparation)
	// - Runs the menu loop (state detection → menu → action → post-action)
	// - Manages cleanup and error handling
	// ============================================================================
	const orchestrator = new CLIOrchestrator(
		prWorkflow,
		stateManager,
		actionExecutor,
		postActionHandler,
	);

	let mcpClient: Awaited<typeof mcpInitPromise>["mcpClient"] | null = null;

	try {
		await orchestrator.run();
	} finally {
		// Close MCP client if it was initialized
		try {
			const { mcpClient: client } = await Promise.race([
				mcpInitPromise,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), 100),
				),
			]);
			mcpClient = client;
		} catch {
			// MCP client not ready or timed out, nothing to close
		}

		if (mcpClient) {
			await mcpClient.close();
		}
	}
};

main().catch((error) => {
	console.error("\n✗ Fatal error:", error);
	process.exit(1);
});
