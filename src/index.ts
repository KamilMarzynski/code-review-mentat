import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent } from "langchain";
import LocalCache from "./cache/local-cache";
import { CommentDisplayService } from "./cli/managers/comment-display-service";
import { CommentResolutionManager } from "./cli/managers/comment-resolution-manager";
import { FixSessionOrchestrator } from "./cli/managers/fix-session-orchestrator";
import { PRWorkflowManager } from "./cli/managers/pr-workflow-manager";
import { ReviewStreamHandler } from "./cli/managers/review-stream-handler";
import { CLIOrchestrator } from "./cli/orchestrator";
import GitOperations from "./git/operations";
import { createMCPClient, getMCPTools } from "./mcp/client";
import BitbucketServerProvider from "./providers/bitbucket";
import { CodeReviewer } from "./review/code-reviewer";
import { CommentFixer } from "./review/comment-fixer";
import { ContextGatherer } from "./review/context-gatherer";
import { ReviewService } from "./review/review-service";
import { UILogger } from "./ui/logger";

const { PATH_TO_CLAUDE } = process.env;
if (!PATH_TO_CLAUDE) {
	throw new Error("PATH_TO_CLAUDE environment variable is not set.");
}

const main = async () => {
	// Initialize MCP client and tools
	const mcpClient = createMCPClient();
	const tools = await getMCPTools(mcpClient);

	// Initialize LangChain model
	const model = new ChatAnthropic({
		model: "claude-sonnet-4-5-20250929",
		temperature: 0,
	});

	// Create LangChain agent for context gathering
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
- Maximum 5 tool calls
- Skip information already in the PR description
- Focus on REQUIREMENTS, not implementation details`,
	});

	// Initialize infrastructure services
	const git = new GitOperations();
	const cache = new LocalCache();
	const ui = new UILogger();

	// Initialize review services
	const contextGatherer = new ContextGatherer(contextGathererAgent);
	const codeReviewer = new CodeReviewer(PATH_TO_CLAUDE);
	const reviewService = new ReviewService(contextGatherer, codeReviewer);
	const commentFixer = new CommentFixer(PATH_TO_CLAUDE);

	// Provider factory function
	const createProvider = (remote: string) =>
		new BitbucketServerProvider(remote);

	const prWorkflow = new PRWorkflowManager(git, createProvider, ui);
	const commentResolution = new CommentResolutionManager(cache, ui);
	const reviewHandler = new ReviewStreamHandler(
		reviewService,
		cache,
		ui,
		commentResolution,
	);
	const fixSession = new FixSessionOrchestrator(commentFixer, git, cache, ui);
	const commentDisplay = new CommentDisplayService(ui);

	// Initialize and run orchestrator
	const orchestrator = new CLIOrchestrator(
		prWorkflow,
		reviewHandler,
		commentResolution,
		fixSession,
		commentDisplay,
		cache,
	);

	try {
		await orchestrator.run();
	} finally {
		// Close MCP client to allow process to exit
		await mcpClient.close();
	}
};

main().catch((error) => {
	console.error("\n✗ Fatal error:", error);
	process.exit(1);
});
