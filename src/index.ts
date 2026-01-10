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
	// Start MCP initialization in background (don't await yet)
	const mcpInitPromise = (async () => {
		const mcpClient = createMCPClient();
		const tools = await getMCPTools(mcpClient);
		return { mcpClient, tools };
	})();

	// Initialize infrastructure services (can happen in parallel with MCP)
	const git = new GitOperations();
	const cache = new LocalCache();
	const ui = new UILogger();

	// Initialize LangChain model
	const model = new ChatAnthropic({
		model: "claude-sonnet-4-5-20250929",
		temperature: 0,
	});

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
- Maximum 5 tool calls
- Skip information already in the PR description
- Focus on REQUIREMENTS, not implementation details`,
		});
		return new ContextGatherer(contextGathererAgent);
	};

	// Initialize review services
	const codeReviewer = new CodeReviewer(PATH_TO_CLAUDE);
	const reviewService = new ReviewService(createContextGatherer, codeReviewer);
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
