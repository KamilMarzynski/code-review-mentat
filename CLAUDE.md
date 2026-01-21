# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an automated code review CLI tool that uses Claude Code to review pull requests from Git providers (currently Bitbucket Server, with plans for GitLab and GitHub). The tool:
1. Fetches pull request details from the Git provider API
2. Gathers additional context from Jira/Confluence via MCP servers
3. Uses Claude Code Agent SDK (`claude-sonnet-4-5-20250929`) to perform automated code review in read-only mode
4. Returns structured, verified review comments with severity levels and status tracking
5. Supports interactive comment fixing with planning and execution phases

## Prerequisites

Required environment variables:
- `BB_TOKEN`: BitBucket Personal Access Token for API authentication
- `ANTHROPIC_API_KEY`: Anthropic API key for Claude model access
- `PATH_TO_CLAUDE`: Absolute path to Claude Code executable

## Common Commands

### Running the tool
```bash
bun run index.ts
```

### Installing dependencies
```bash
bun install
```

### Linting
```bash
# This project uses Biome for linting and formatting
bun biome check
```

## Architecture

The codebase uses a **menu-driven state machine** with clear layered architecture and dependency injection:

### Architectural Layers (Bottom-Up)

1. **Infrastructure Layer**: Git operations, MCP client, caching, memory storage
2. **Service Layer**: Git providers, review services (CodeReviewer, ContextGatherer, CommentFixer)
3. **Manager Layer**: CLI managers for workflow orchestration, state detection, and action execution
4. **Orchestrator Layer**: Main CLI orchestrator coordinating the entire interactive flow

### Entry Point: `index.ts`
Main orchestration file with multi-layer dependency injection (lines 25-158):

**Infrastructure Layer Setup**:
- `GitOperations` (from `src/git/operations.ts`)
- `LocalCache` for caching layer
- `MemoryStorage` for comment persistence
- `MCPClient` for Atlassian MCP tools

**Service Layer Setup**:
- Git provider factory (`createGitProvider` from `git-providers/factory.ts`)
- `CodeReviewer` with comment verification
- `ContextGathererFactory` for lazy initialization
- `CommentFixer` for fixing workflow

**Manager Layer Setup**:
- `WorkflowStateManager` - Detects current workflow state and generates menu options
- `ActionExecutor` - Executes workflow actions (gather_context, run_review, handle_pending, etc.)
- `PostActionHandler` - Smart post-action flow transitions
- `PRWorkflowManager` - Orchestrates PR selection and workflow
- `CommentResolutionManager` - Handles comment acceptance/rejection
- `CommentDisplayService` - Displays comments with formatting
- `FixSessionOrchestrator` - Orchestrates fixing workflow

**Orchestrator**:
- `CLIOrchestrator` - Main interactive menu-driven loop

The orchestrator runs a state machine:
1. Detect current workflow state
2. Generate contextual menu options
3. Execute selected action
4. Handle post-action transitions
5. Loop until user exits

### CLI Manager Layer: `src/cli/managers/`

**`workflow-state-manager.ts`**:
- Detects current workflow state based on available data
- Generates contextual menu options for each state
- States: initial, remote_selected, pr_selected, context_gathered, review_complete, comments_pending, etc.

**`action-executor.ts`**:
- Centralized execution of all workflow actions
- Actions: select_remote, select_pr, gather_context, run_review, handle_pending, send_accepted, run_fix, etc.
- Coordinates between git operations, providers, and review services

**`post-action-handler.ts`**:
- Smart flow transitions after action completion
- Auto-advances workflow or prompts for next steps
- Handles state-specific logic (e.g., after review → handle pending comments)

**`pr-workflow-manager.ts`**:
- Orchestrates PR selection workflow
- Fetches PRs from provider, displays interactive selection
- Manages PR metadata and state

**`comment-resolution-manager.ts`**:
- Handles comment acceptance, rejection, and fixing requests
- Integrates with memory storage for comment persistence
- Manages comment status transitions

**`comment-display-service.ts`**:
- Formats and displays review comments with color coding
- Groups comments by file
- Shows severity, confidence, and verification status

**`fix-session-orchestrator.ts`**:
- Orchestrates the comment fixing workflow
- Coordinates between planning and execution phases
- Manages fix iterations and verification

### Review Services: `src/review/`

**`code-reviewer.ts`**:
- Executes code review via Claude Code Agent SDK
- **Read-only mode**: Only allows `Read`, `Grep`, `Glob` tools
- **Comment verification**: Validates comments against actual tool usage
- **Confidence scoring**: Assigns high/medium/low confidence based on evidence
- **Evidence tracking**: Populates `verifiedBy` field with tool call references
- Returns `StoredReviewComment[]` with status tracking

**`context-gatherer.ts`**:
- Uses LangChain agent with Atlassian MCP tools (Jira/Confluence)
- Extracts Jira ticket references from PR title/description/commits
- Fetches relevant context to understand requirements
- Limited to 5 tool calls per PR to control costs
- Returns context summary for code review

**`context-gatherer-factory.ts`**:
- Lazy initialization of ContextGatherer
- Only creates instance when context gathering is needed
- Handles MCP client initialization

**`comment-fixer.ts`**:
- Executes comment fixing workflow with planning phase
- Plans fixes before execution
- Verifies fixes after execution
- Tracks fix iterations with `FixIteration` type

**`claude-query-executor.ts`**:
- Direct Claude query execution for planning and fixing
- Handles streaming events and responses
- Manages tool usage restrictions

### Git Operations: `src/git/operations.ts`
Encapsulates all git operations via `simple-git`:
- `getRemotes()` - Fetch all remotes with refs
- `getCurrentBranch()` - Get current branch name
- `pull(remote)` - Pull latest changes
- `checkout(commitOrBranch)` - Checkout commit/branch
- `getDiff(from, to)` - Get full diff between commits
- `getDiffSummary(from, to)` - Get list of changed files

### Provider System: `git-providers/`
Abstraction layer for Git provider integrations:

**`git-providers/types.ts`**:
- `GitProvider` interface - Common contract for all providers
- `RemoteInfo` - Parsed remote information (host, projectKey, repoSlug)
- `PullRequest` - Provider-agnostic PR representation
- `BranchInfo` - Branch name and commit hash

**`git-providers/bitbucket.ts`**:
- Implements `GitProvider` interface for Bitbucket Server
- `parseRemote(sshRemote)` - Parses SSH remote URL to RemoteInfo
- `fetchPullRequests(remote)` - Fetches open PRs from Bitbucket REST API
- `fetchCommits(remote, pr)` - Fetches commit messages for a PR
- Uses BB_TOKEN for Bearer authentication

**`git-providers/factory.ts`**:
- Factory for creating provider instances
- `createGitProvider(remote)` - Returns appropriate provider based on remote URL
- Extensible for adding new providers

### Review Types: `src/review/types.ts`
Comprehensive type definitions for review workflow:

**`ReviewComment` Structure** (base comment type):
- `file`: string - File path (required)
- `line?`: number - Single line number
- `startLine?`, `endLine?`: number - Line range for multi-line comments
- `severity?`: 'nit' | 'suggestion' | 'issue' | 'risk'
- `message`: string - Comment message (required)
- `rationale?`: string - Explanation for the comment

**`StoredReviewComment` Structure** (extends ReviewComment):
- `status`: 'pending' | 'accepted' | 'rejected' | 'fixed' - Comment lifecycle status
- `confidence?`: 'high' | 'medium' | 'low' - Confidence level based on verification
- `verifiedBy?`: string[] - Tool call references that verify the comment
- `memoryCreated?`: boolean - Whether memory was created for this comment

**`FixIteration` Structure**:
- `attemptNumber`: number
- `planningOutput?`: string - Planning phase output
- `executionOutput?`: string - Execution phase output
- `timestamp`: string

**Event Streaming Types**:
- `StreamEvent` - Base event type
- `ContextEvent` - Context gathering events
- `ReviewEvent` - Review execution events
- Type guards: `isContextEvent()`, `isReviewEvent()`

**Input/Output Types**:
- `ContextGatherInput` / `ContextGatherOutput`
- `ReviewInput` / `ReviewOutput`

### Infrastructure: `src/`

**`cache/local-cache.ts`**:
- Simple in-memory caching layer
- Used for caching PR data and context

**`db/memory-storage.ts`**:
- Persistent storage for review comments
- Supports comment CRUD operations
- Tracks comment status transitions

**`mcp/client.ts`**:
- MCP client initialization
- Atlassian MCP server: `npx -y mcp-remote https://mcp.atlassian.com/v1/sse`
- Automatic restart logic (max 3 attempts, 1s delay)

**`ui/` directory**:
- `logger.ts` - Logging utilities
- `theme.ts` - Color theme for CLI
- Display formatting helpers

**`cli/display.ts`**:
- CLI display utilities
- Formatted output for various workflow states

## Workflows

### Context Gathering Workflow
1. Extract Jira ticket references from PR metadata
2. Use MCP tools to fetch Jira ticket details and Confluence pages
3. Generate context summary for code review
4. Limit to 5 tool calls to control costs

### Code Review Workflow
1. Checkout PR source commit (detached HEAD)
2. Pass diff + context to CodeReviewer
3. Claude Code executes in read-only mode with tool restrictions
4. Comments are verified against actual tool usage
5. Confidence scoring based on evidence quality
6. Return structured comments with status tracking
7. Restore original branch

### Comment Fixing Workflow
1. User selects comments to fix from pending list
2. **Planning Phase**: CommentFixer generates fix plan
3. User reviews plan
4. **Execution Phase**: CommentFixer executes fixes
5. Verification of fixes
6. Update comment status (pending → fixed)
7. Track fix iteration in FixIteration type

### Menu-Driven Flow
1. **State Detection**: WorkflowStateManager detects current state
2. **Menu Generation**: Generate contextual options based on state
3. **User Selection**: User selects action from menu
4. **Action Execution**: ActionExecutor executes selected action
5. **Post-Action**: PostActionHandler manages transitions
6. **Loop**: Return to state detection

## Comment Verification System

The tool includes a sophisticated comment verification system to ensure accuracy:

### Verification Process
1. **Tool Usage Tracking**: Track all tool calls during review (Read, Grep, Glob)
2. **Evidence Matching**: Match each comment's file/line claims against actual tool calls
3. **Confidence Scoring**:
   - **High**: Comment verified by specific tool call (e.g., Read file:line)
   - **Medium**: Partially verified (e.g., file read but not specific line)
   - **Low**: No direct verification found
4. **Downgrade Logic**: Comments without evidence are flagged with lower confidence
5. **Evidence Tracking**: `verifiedBy` field contains tool call IDs that support the comment

### ReviewComment Fields for Verification
- `confidence`: Assigned during verification process
- `verifiedBy`: Array of tool call references (e.g., `['Read:src/file.ts:42']`)
- Helps identify comments that may need manual review

## Key Design Decisions

### Menu-Driven State Machine
- **Benefit**: Flexible, user-controlled workflow
- **Implementation**: State detection → menu generation → action execution → transitions
- **States**: Dynamically determined based on available data (remote, PR, context, comments)

### Provider Extensibility
The provider interface is designed for easy extension:
- Each provider implements `GitProvider` interface
- Factory pattern for provider instantiation
- To add GitLab/GitHub: Create `git-providers/gitlab.ts` or `git-providers/github.ts` implementing the interface

### Read-Only Review Mode
Safety is enforced at multiple levels:
- `allowedTools: ['Read', 'Grep', 'Glob']`
- `disallowedTools: ['Edit', 'Write']`
- `canUseTool` hook denies Edit/Write even if settings enable them
- System prompt explicitly states read-only mode

### Git Operations Safety
- Tool checks out PR source commit (detached HEAD state)
- Always restores original branch after review
- Pulls latest changes before checkout to ensure accurate diff

### Comment Status Tracking
- Comments have lifecycle: pending → accepted/rejected/fixed
- Memory storage persists comment state
- Enables iterative workflows (review → fix → re-review)

### Lazy Initialization
- ContextGatherer only created when needed (via factory)
- MCP client initialized on-demand
- Reduces startup time and resource usage

## Project Configuration

- **Runtime**: Bun (macOS only)
- **TypeScript**: Strict mode, module resolution: bundler, no emit
- **Linting**: Biome for linting and formatting
- **Model**: claude-sonnet-4-5-20250929
- **Key Dependencies**:
  - `@anthropic-ai/claude-agent-sdk` - Claude Code integration
  - `@langchain/anthropic` - Claude model client
  - `@langchain/mcp-adapters` - MCP server integration
  - `simple-git` - Git operations
  - `@clack/prompts` - CLI prompts
  - `sqlite-vec` - Vector storage (future use)

## Future Extensions

### Multiple Provider Support
When adding multiple providers:
1. Create new provider class implementing `GitProvider` interface
2. Update `git-providers/factory.ts` to detect and instantiate new provider
3. Add provider-specific configuration (env vars or config file)
4. No changes needed to manager layer, review services, or git operations

### Additional Features to Consider
- PR comment posting (currently local-only)
- GitHub/GitLab provider implementations
- Custom review rule configurations
- Integration with additional MCP servers
- Vector storage for semantic code search
