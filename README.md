# Code Review Mentat

An AI-powered command-line tool that transforms your code review workflow using Claude AI. Beyond just reviewing your code, it assists you in reviewing other engineers' pull requests, posting AI-generated comments to remote repositories, and helping you address feedback left by other reviewers.

> 📌 **Current Status:** Currently supports **Bitbucket Server** only, as it's the git server solution used at my company.

## About the Name

Also known as **Code Review Mentat** (CRM), inspired by the Mentats from Frank Herbert's Dune universe. In Dune, Mentats are human computers trained to perform complex logical computations and analysis—much like this tool performs deep code analysis and reviews. 

_(Yes, we're aware that thinking machines are forbidden in the Dune universe)_ 🏜️

> ⚠️ **Early Development Notice**  
> This project is in very early development (v0.1.0) and will continue to evolve. Current functionality focuses on code review analysis and insights. **Not yet implemented:** automatically fixing issues, posting comments to remote repositories, or helping address reviewer feedback. Expect breaking changes and new features in upcoming releases.

## Features

### Current Features

- 🔍 Fetch and review pull requests from Bitbucket Server
- 🧠 AI-powered code review using Claude Sonnet 4.5
- 📋 Automatic context gathering from Jira tickets and Confluence documentation
- 💾 Local caching for improved performance
- 🎨 Beautiful CLI interface with progress indicators
- 🔄 Git integration for local repository analysis

### Planned Features

- 💬 Post AI-generated review comments directly to pull requests
- 🔧 Help address and respond to reviewer comments on your pull requests
- 🔨 Automatically fix issues identified during code review

## Prerequisites

Before you begin, ensure you have the following installed and configured:

### Required Software

- **[Bun](https://bun.sh)** v1.3.4 or later (JavaScript runtime)
- **macOS** (currently only macOS is supported)
- **Claude Desktop** application with the Code executable
- **Git** installed and configured

### Required Access & Credentials

You need to set up the following environment variables:

1. **`ANTHROPIC_API_KEY`** - Your Anthropic API key for Claude AI  
   Get it from: https://console.anthropic.com/

2. **`BB_TOKEN`** - Your Bitbucket Personal Access Token  
   Generate from your Bitbucket Server settings with read permissions for repositories and pull requests

3. **`PATH_TO_CLAUDE`** - Path to your Claude Code executable file  
   Example: `/Applications/Claude.app/Contents/MacOS/Claude`

### Setting Environment Variables

Add these to your shell configuration file (`~/.zshrc` or `~/.bashrc`):

```bash
export ANTHROPIC_API_KEY="your-anthropic-api-key"
export BB_TOKEN="your-bitbucket-token"
export PATH_TO_CLAUDE="/Applications/Claude.app/Contents/MacOS/Claude"
```

Then reload your configuration:
```bash
source ~/.zshrc  # or source ~/.bashrc
```

> 📝 **Note:** Environment variable configuration will be replaced with a config file in future versions.

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd code-review-cli
```

2. Install dependencies:
```bash
bun install
```

3. Build the executable:
```bash
bun run build
```

This creates a standalone `code-review` executable.

### Installation Options

**Option A: Add to PATH (Recommended)**

Move the executable to a directory in your PATH:
```bash
sudo mv code-review /usr/local/bin/
```

Now you can run `code-review` from any repository.

**Option B: Copy to Target Repository**

Copy the `code-review` executable to the root of the repository you want to review:
```bash
cp code-review /path/to/your/repository/
cd /path/to/your/repository/
./code-review
```

## Usage

Navigate to the repository you want to review and run:

```bash
code-review
```

Or if you copied the executable to the repository:

```bash
./code-review
```

The tool will:

1. Prompt you to select a pull request from your Bitbucket instance
2. Fetch the pull request details and changes
3. Gather relevant context from Jira and Confluence
4. Perform an AI-powered code review
5. Display findings and suggestions

## Development

For developing the code-review-cli tool itself:

### Running in Development Mode

```bash
bun run start
```

> ⚠️ **Note:** This will attempt to review the code-review-cli repository itself. For reviewing other projects, use the built executable.

### Building

```bash
bun run build
```

### Linting

Check code quality:
```bash
bun run lint
```

Auto-fix linting issues:
```bash
bun run lint:fix
```

### Project Structure

```
src/
├── index.ts              # Main entry point
├── cache/                # Local caching implementation
├── cli/                  # CLI interface and orchestration
├── git/                  # Git operations
├── mcp/                  # Model Context Protocol client
├── providers/            # Bitbucket integration
├── review/               # Code review logic
└── ui/                   # UI components and logging
```

## Testing

> 🚧 Testing infrastructure is coming soon in future releases.

## Roadmap

### Core Features

- [ ] Post review comments directly to remote pull requests
- [ ] Help address reviewer feedback on your pull requests
- [ ] Automatic issue fixing based on review findings
- [ ] Interactive code cleanup workflows

### Platform & Integration

- [ ] Support for GitHub and GitHub Enterprise
- [ ] Support for GitLab
- [ ] Configuration file support (replacing environment variables)
- [ ] CI/CD integration and hooks

### Enhancements

- [ ] Multi-platform support (Linux, Windows)
- [ ] Comprehensive test suite

## Contributing

Contributions are welcome! This is an early-stage project, so there's plenty of room for improvement and new ideas.

## License

MIT

## Acknowledgments

Built with:
- [Bun](https://bun.sh) - Fast JavaScript runtime
- [Claude AI](https://www.anthropic.com) - AI-powered code analysis
- [LangChain](https://www.langchain.com) - AI framework
- [LangGraph](https://langchain-ai.github.io/langgraph/) - Multi-agent workflow orchestration
- [@clack/prompts](https://github.com/natemoo-re/clack) - Beautiful CLI prompts
