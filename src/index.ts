import { ChatAnthropic } from "@langchain/anthropic";
import { createAgent } from "langchain";
import LocalCache from "./cache/local-cache";
import { CLIOrchestrator } from "./cli/orchestrator";
import GitOperations from "./git/operations";
import { createMCPClient, getMCPTools } from "./mcp/client";
import BitbucketServerProvider from "./providers/bitbucket";
import { CodeReviewer } from "./review/code-reviewer";
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
	const agent = createAgent({
		model,
		tools,
		systemPrompt:
			"You are an assistant capable of fetching information about pull request based on pull request history." +
			"You should be concrete and percise in your search. Limit the number of tool calls to avoid excessive calls. You are limitted to 5 tool calls per pull request." +
			"Your task is to find information about jira ticket in pull request data, commits, descritpion or title and fetch this ticket information from jira system." +
			"Next try to find information in confluence system about anything that migh help to do code review of this pull request." +
			"Do not make code review yet, just collect information using available tools." +
			"As a result of your research, provide a summary of found information that might help to do code review of this pull request. Do not provide information that can be easile found in pull request itself, only provide additional context information." +
			"Ensure that you response is suited for an AI agent to use it in code review.",
	});

	// Initialize infrastructure services
	const git = new GitOperations();
	const cache = new LocalCache();
	const ui = new UILogger();

	// Initialize review services
	const contextGatherer = new ContextGatherer(agent);
	const codeReviewer = new CodeReviewer(PATH_TO_CLAUDE);
	const reviewService = new ReviewService(contextGatherer, codeReviewer);

	// Provider factory function
	const createProvider = (remote: string) =>
		new BitbucketServerProvider(remote);

	// Initialize and run orchestrator
	const orchestrator = new CLIOrchestrator(
		git,
		createProvider,
		reviewService,
		cache,
		ui,
	);
	await orchestrator.run();
};

main().catch((error) => {
	console.error("\n✗ Fatal error:", error);
	process.exit(1);
});
