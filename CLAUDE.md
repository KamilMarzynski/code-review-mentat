# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is an automated code review CLI tool that uses Claude Code and LangGraph to review pull requests from Git providers (currently Bitbucket Server, with plans for GitLab and GitHub). The tool:
1. Fetches pull request details from the Git provider API
2. Gathers additional context from Jira/Confluence via MCP servers
3. Uses Claude Code Agent SDK to perform automated code review in read-only mode
4. Returns structured review comments with severity levels

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
# This project uses ESLint with Airbnb TypeScript config
bun eslint .
```

## Architecture

The codebase is organized by responsibility with clear separation of concerns:

### Entry Point: `index.ts`
Main orchestration file that:
- Uses `@clack/prompts` for interactive CLI (remote selection, PR selection)
- Instantiates provider (currently `BitbucketProvider`) and `GitOperations`
- Coordinates the workflow: fetch PRs → select PR → checkout → get diff → fetch commits → run review
- No business logic - delegates to specialized modules

### Review Graph: `graph.ts`
LangGraph-based two-node state machine for the review workflow:

1. **contextSearchCall node**:
   - Uses a LangChain agent with Atlassian MCP tools (Jira/Confluence)
   - Extracts Jira ticket references from PR title/description/commits
   - Fetches relevant context to understand requirements
   - Limited to 5 tool calls per PR to control costs
   - Returns context summary for code review

2. **reviewCall node**:
   - Calls Claude Code via `@anthropic-ai/claude-agent-sdk`'s `query()` function
   - Runs in **read-only mode** with `canUseTool` hook denying Edit/Write tools
   - Only allows Grep, Glob, and Read tools
   - Uses structured JSON output for `ReviewComment[]` objects
   - Review priorities: correctness, security, data loss, breaking changes, performance, maintainability

### Git Operations: `git.ts`
Encapsulates all git operations via `simple-git`:
- `getRemotes()` - Fetch all remotes with refs
- `getCurrentBranch()` - Get current branch name
- `pull(remote)` - Pull latest changes
- `checkout(commitOrBranch)` - Checkout commit/branch
- `getDiff(from, to)` - Get full diff between commits
- `getDiffSummary(from, to)` - Get list of changed files

### Provider System: `providers/`
Abstraction layer for Git provider integrations:

**`providers/types.ts`**:
- `GitProvider` interface - Common contract for all providers
- `RemoteInfo` - Parsed remote information (host, projectKey, repoSlug)
- `PullRequest` - Provider-agnostic PR representation
- `BranchInfo` - Branch name and commit hash

**`providers/bitbucket.ts`**:
- Implements `GitProvider` interface for Bitbucket Server
- `parseRemote(sshRemote)` - Parses SSH remote URL to RemoteInfo
- `fetchPullRequests(remote)` - Fetches open PRs from Bitbucket REST API
- `fetchCommits(remote, pr)` - Fetches commit messages for a PR
- Uses BB_TOKEN for Bearer authentication

### Review Types: `review-types.ts`
Currently only contains `BranchData` type (will be moved to providers/types.ts or removed in future cleanup).

## State Management

**LangGraph State Schema** (in `graph.ts`):
- `commits`: string[] - Commit messages
- `diff`: string - Full git diff
- `title`, `description`, `editedFiles` - PR metadata
- `messages`: BaseMessage[] - Conversation history for context agent
- `context`: string - Output from contextSearchCall (Jira/Confluence info)
- `result`: string - Final review result text
- `comments`: ReviewComment[] - Structured review comments

**ReviewComment Structure**:
- `file`: string - File path (required)
- `line?`: number - Single line number
- `startLine?`, `endLine?`: number - Line range
- `severity?`: 'nit' | 'suggestion' | 'issue' | 'risk'
- `message`: string - Comment message (required)
- `rationale?`: string - Explanation for the comment

## Key Design Decisions

### Provider Extensibility
The provider interface is designed for easy extension:
- Each provider implements `GitProvider` interface
- Future: Loop through multiple configured providers, first successful one wins
- To add GitLab/GitHub: Create `providers/gitlab.ts` or `providers/github.ts` implementing the interface

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

### MCP Integration
- Uses `@langchain/mcp-adapters` MultiServerMCPClient
- Atlassian MCP server: `npx -y mcp-remote https://mcp.atlassian.com/v1/sse`
- Includes automatic restart logic (max 3 attempts, 1s delay)

## Project Configuration

- **Runtime**: Bun (macOS only)
- **TypeScript**: Strict mode, module resolution: bundler, no emit
- **Linting**: Airbnb TypeScript base config
- **Key Dependencies**:
  - `@anthropic-ai/claude-agent-sdk` - Claude Code integration
  - `@langchain/langgraph` - State graph for workflow
  - `@langchain/anthropic` - Claude model client
  - `@langchain/mcp-adapters` - MCP server integration
  - `simple-git` - Git operations
  - `@clack/prompts` - CLI prompts

## Future Extensions

When adding multiple provider support:
1. Create new provider class implementing `GitProvider` interface
2. Add provider configuration (env vars or config file)
3. Update `index.ts` to try each configured provider until one succeeds
4. No changes needed to `graph.ts`, `git.ts`, or review logic
