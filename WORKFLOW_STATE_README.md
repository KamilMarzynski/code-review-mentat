# Workflow State Management System

This module implements the state detection infrastructure for Phase 1 of the workflow state machine refactoring.

## Overview

The workflow state management system provides a foundation for detecting the current state of a PR review workflow and generating contextually appropriate menu options for the user.

## Components

### Types (`src/cli/types.ts`)

Core type definitions for the workflow state machine:

- **`WorkflowAction`**: Enum of available actions (gather_context, run_review, handle_pending, etc.)
- **`WorkflowState`**: Complete state representation including context, comments, and PR status
- **`MenuOption`**: Menu option with label, hints, and recommendation flags
- **`ContextMetadata`**: Metadata about gathered context

### WorkflowStateManager (`src/cli/managers/workflow-state-manager.ts`)

Central state management class with three key methods:

1. **`detectState(pr: PullRequest): Promise<WorkflowState>`**
   - Detects current workflow state by examining cache and comments
   - Determines if context is up-to-date
   - Counts comments by status
   - Checks for new commits

2. **`getAvailableActions(state: WorkflowState): WorkflowAction[]`**
   - Returns list of actions available based on current state
   - Example: `gather_context` only shown when no context exists

3. **`generateMenuOptions(state: WorkflowState, actions: WorkflowAction[]): MenuOption[]`**
   - Generates user-friendly menu options with hints and recommendations
   - Adds warnings where appropriate (e.g., "No context available")
   - Marks recommended actions with flags

## Usage Example

```typescript
import { WorkflowStateManager } from "./cli/managers/workflow-state-manager";
import LocalCache from "./cache/local-cache";

// Initialize
const cache = new LocalCache();
const stateManager = new WorkflowStateManager(cache);

// Detect state
const state = await stateManager.detectState(pullRequest);

// Get available actions
const actions = stateManager.getAvailableActions(state);

// Generate menu options
const options = stateManager.generateMenuOptions(state, actions);

// Display menu to user (future implementation)
// const selectedAction = await promptWorkflowMenu(options);
```

## State Detection Logic

The system detects the following aspects:

### Context State
- **Has Context**: Whether deep context has been gathered
- **Context Up-to-date**: Whether context commit matches current PR commit
- **Context Metadata**: When gathered and from which commit

### Comments State
- **Has Comments**: Whether any comments exist
- **Pending Count**: Comments awaiting action
- **Accepted Count**: Comments accepted for posting
- **Fixed Count**: Comments that were fixed
- **Rejected Count**: Comments that were rejected

### PR State
- **Current Commit**: The latest commit on the source branch
- **Has New Commits**: Whether there are new commits since last context/review

## Available Actions

Actions are conditionally available based on state:

| Action | Availability |
|--------|-------------|
| `gather_context` | When no context exists |
| `refresh_context` | When context exists but is outdated |
| `run_review` | Always available |
| `handle_pending` | When pendingCount > 0 |
| `send_accepted` | When acceptedCount > 0 |
| `exit` | Always available |

## Menu Generation

Menu options include:

- **Label**: User-friendly action name with emoji
- **Hint**: Contextual information about the action
- **Recommended**: Flag to highlight suggested actions (⭐)
- **Warning Hint**: Special warnings (e.g., "No context available")

### Example Menu Output

```
? What would you like to do?
  ⭐ 🔍 Gather Deep Context
     Recommended: Get Jira/Confluence context (enables better review)
  
  📝 Run Review
     ⚠ Warning: No context - review will be limited
  
  🔧 Handle 3 Pending Comments
     Review and resolve pending comments
  
  ✓ Exit
```

## Testing

Comprehensive unit tests cover:

- State detection with various cache/comment combinations
- Action availability logic
- Menu option generation
- Edge cases (no status field, outdated context, etc.)

Run tests:
```bash
bun test src/cli/managers/__tests__/workflow-state-manager.test.ts
```

## Backward Compatibility

This implementation is **fully backward compatible**:

- No existing code is modified
- New files are independent modules
- Can be integrated incrementally
- Existing workflow continues to function unchanged

## Next Steps (Phase 2+)

Future phases will build on this foundation:

1. **Phase 2**: Menu System - Create `promptWorkflowMenu()` function
2. **Phase 3**: Action Executors - Extract action handlers
3. **Phase 4**: Post-Action Handlers - Smart flow after actions
4. **Phase 5**: Comment Resolution Refactoring - Split data/UI concerns
5. **Phase 6**: Main Orchestrator Refactoring - Menu-driven loop

## Architecture Benefits

- **Separation of Concerns**: State detection separate from UI
- **Testable**: Pure functions with clear inputs/outputs
- **Extensible**: Easy to add new states or actions
- **Type-Safe**: Full TypeScript coverage with strict types
- **Maintainable**: Clear responsibilities and documentation
