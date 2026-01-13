# Workflow State Machine Refactoring Plan

## Overview
Transform the current linear workflow into a dynamic, menu-driven state machine that detects workflow state after each action and presents contextually appropriate options to the user.

---

## Current Problems

1. **Fixed Linear Flow**: The current implementation follows a rigid sequence that doesn't adapt to the actual state
2. **Poor UX for Partial Work**: Users with partially completed work (e.g., context gathered but no review) don't get optimal prompts
3. **Missing State Detection**: Tool doesn't properly detect and communicate current workflow state
4. **Inflexible Decision Points**: Users can't easily jump between different actions based on their needs
5. **Prompting Issues**: Prompts appear in wrong order (e.g., "new review?" before "send accepted comments?")

---

## Target Architecture

### High-Level Flow
```
START
  ↓
[Initial Setup: Workspace Check, Remote, PR Selection, Repo Prep]
  ↓
[State Detection & Menu Loop]
  ├→ Action Selected
  ├→ Execute Action
  ├→ Smart Post-Action Prompt (if applicable)
  ├→ Re-detect State
  └→ Back to Menu (or Exit)
```

### State Detection System

**Workflow State Components:**
```typescript
interface WorkflowState {
  // Context state
  hasContext: boolean;
  contextUpToDate: boolean;  // gathered commit === current PR commit
  contextMeta?: {
    gatheredAt: Date;
    gatheredFromCommit: string;
  };
  
  // Review/Comments state
  hasComments: boolean;
  pendingCount: number;
  acceptedCount: number;
  fixedCount: number;
  rejectedCount: number;
  
  // Future: Remote comments state
  hasRemoteComments: boolean;
  remoteCommentsCount: number;
  
  // PR state
  currentCommit: string;
  hasNewCommits: boolean; // since last context/review
}
```

**Available Actions Based on State:**
```typescript
type WorkflowAction =
  | "gather_context"      // Always available
  | "refresh_context"     // Available when context exists but outdated
  | "run_review"          // Always available (with warnings if no context)
  | "handle_pending"      // Available when pendingCount > 0
  | "send_accepted"       // Available when acceptedCount > 0
  | "handle_remote"       // Available when hasRemoteComments (future)
  | "exit";               // Always available
```

---

## Implementation Phases

### Phase 1: State Detection Infrastructure

#### 1.1 Create State Manager
**File:** `src/cli/managers/workflow-state-manager.ts`

**Responsibilities:**
- Detect current workflow state
- Determine available actions
- Generate menu options with appropriate hints/recommendations

**Key Methods:**
```typescript
class WorkflowStateManager {
  constructor(
    private cache: LocalCache,
    private git: GitOperations
  )
  
  // Core state detection
  async detectState(pr: PullRequest): Promise<WorkflowState>
  
  // Determine what actions are available
  getAvailableActions(state: WorkflowState): WorkflowAction[]
  
  // Generate menu options with hints
  generateMenuOptions(
    state: WorkflowState,
    actions: WorkflowAction[]
  ): MenuOption[]
}
```

#### 1.2 Menu Option Types
**File:** `src/cli/types.ts` (new file)

```typescript
interface MenuOption {
  value: WorkflowAction;
  label: string;
  hint?: string;
  recommended?: boolean;      // Shows ⭐ indicator
  requiresContext?: boolean;  // For warnings
  warningHint?: string;       // Special warning to display
}

interface WorkflowState {
  // ... as defined above
}
```

---

### Phase 2: Menu System

#### 2.1 Create Menu Prompt
**File:** `src/cli/cli-prompts.ts` (add to existing)

```typescript
async function promptWorkflowMenu(
  options: MenuOption[]
): Promise<WorkflowAction>
```

**Features:**
- Display options with recommendations (⭐)
- Show hints for each option
- Display warnings (⚠) for actions that might not be optimal
- Handle cancellation gracefully

**Example Output:**
```
? What would you like to do?
  ⭐ 🔍 Gather Context
     Recommended: Get Jira/Confluence context (enables better review)
  
  📝 Run Review
     ⚠ Warning: No context available - review will be limited
  
  🔧 Handle 3 Pending Comments
     Review and resolve pending comments
  
  ✓ Exit
```

---

### Phase 3: Action Executors

#### 3.1 Extract Action Handlers
**File:** `src/cli/managers/action-executor.ts` (new)

**Purpose:** Centralize execution of each workflow action

```typescript
class ActionExecutor {
  constructor(
    private prWorkflow: PRWorkflowManager,
    private reviewHandler: ReviewStreamHandler,
    private commentResolution: CommentResolutionManager,
    private fixSession: FixSessionOrchestrator,
    private commentDisplay: CommentDisplayService,
    private cache: LocalCache
  )
  
  // Execute context gathering
  async executeGatherContext(
    pr: PullRequest,
    refresh: boolean
  ): Promise<void>
  
  // Execute review
  async executeReview(
    pr: PullRequest,
    provider: GitProvider,
    state: WorkflowState
  ): Promise<ReviewResult>
  
  // Execute pending comment handling
  async executeHandlePending(
    pr: PullRequest
  ): Promise<HandleCommentsResult>
  
  // Execute send accepted
  async executeSendAccepted(
    pr: PullRequest,
    provider: GitProvider
  ): Promise<void>
}

interface ReviewResult {
  commentsCreated: number;
  hasErrors: boolean;
}

interface HandleCommentsResult {
  processed: number;
  fixed: number;
  accepted: number;
  rejected: number;
  skipped: number;
}
```

---

### Phase 4: Smart Flow Orchestration

#### 4.1 Post-Action Behaviors
**File:** `src/cli/managers/post-action-handler.ts` (new)

**Purpose:** Handle smart prompts after specific actions

```typescript
class PostActionHandler {
  constructor(
    private ui: UILogger,
    private stateManager: WorkflowStateManager
  )
  
  // After context gathering
  async afterContextGathered(
    pr: PullRequest
  ): Promise<WorkflowAction | "show_menu">
  
  // After review completes
  async afterReviewCompleted(
    result: ReviewResult,
    pr: PullRequest
  ): Promise<WorkflowAction | "show_menu">
  
  // After handling pending comments
  async afterPendingHandled(
    result: HandleCommentsResult,
    pr: PullRequest
  ): Promise<WorkflowAction | "show_menu">
  
  // After sending accepted
  async afterAcceptedSent(
    pr: PullRequest
  ): Promise<WorkflowAction | "show_menu">
}
```

**Smart Flow Logic:**

1. **After Context Gathered:**
   - Detect new state
   - Show message: "✓ Context gathered successfully"
   - If no pending comments: Prompt "Run review now with this context?"
     - Yes → Execute review
     - No → Show menu
   - If has pending comments: Prompt "Context can help with handling comments. What next?"
     - Handle pending comments
     - Run new review
     - Show menu

2. **After Review Completed:**
   - Show review summary
   - If created new pending comments: Prompt "Review complete. Handle pending comments now?"
     - Yes → Execute handle pending
     - No → Show menu
   - If no new comments: Show menu

3. **After Handling Pending:**
   - Show resolution summary
   - If has accepted comments: Prompt "Send accepted comments to remote?"
     - Yes → Execute send accepted
     - No → Show menu
   - If no accepted: Show menu

4. **After Sending Accepted:**
   - Show success message
   - Always show menu

---

### Phase 5: Main Orchestrator Refactoring

#### 5.1 New CLIOrchestrator Structure
**File:** `src/cli/orchestrator.ts` (major refactor)

```typescript
class CLIOrchestrator {
  constructor(
    private prWorkflow: PRWorkflowManager,
    private reviewHandler: ReviewStreamHandler,
    private commentResolution: CommentResolutionManager,
    private fixSession: FixSessionOrchestrator,
    private commentDisplay: CommentDisplayService,
    private cache: LocalCache,
    private stateManager: WorkflowStateManager,
    private actionExecutor: ActionExecutor,
    private postActionHandler: PostActionHandler
  )
  
  async run(): Promise<void> {
    // Phase 1: Initial Setup (unchanged)
    await this.initialSetup();
    
    // Phase 2: Main Loop
    await this.menuLoop();
    
    // Phase 3: Cleanup
    await this.cleanup();
  }
  
  private async initialSetup(): Promise<SetupContext> {
    // Workspace check
    // Remote selection
    // PR selection
    // Repository preparation
    // Initial data gathering (diff, commits, etc.)
    // Return context object
  }
  
  private async menuLoop(): Promise<void> {
    let shouldContinue = true;
    
    while (shouldContinue) {
      // 1. Detect current state
      const state = await this.stateManager.detectState(this.pr);
      
      // 2. Get available actions
      const actions = this.stateManager.getAvailableActions(state);
      
      // 3. Generate menu options
      const options = this.stateManager.generateMenuOptions(state, actions);
      
      // 4. Show menu and get user choice
      const action = await promptWorkflowMenu(options);
      
      // 5. Handle exit
      if (action === "exit") {
        shouldContinue = false;
        break;
      }
      
      // 6. Execute action
      const result = await this.executeAction(action, state);
      
      // 7. Handle post-action smart flow
      const nextAction = await this.handlePostAction(action, result, state);
      
      // 8. If next action specified, execute it (smart flow)
      if (nextAction !== "show_menu") {
        const nextResult = await this.executeAction(nextAction, state);
        // Could chain further, but keep it simple for now
      }
      
      // Loop continues...
    }
  }
  
  private async executeAction(
    action: WorkflowAction,
    state: WorkflowState
  ): Promise<ActionResult> {
    switch (action) {
      case "gather_context":
        return await this.actionExecutor.executeGatherContext(
          this.pr,
          false // refresh = false
        );
        
      case "refresh_context":
        return await this.actionExecutor.executeGatherContext(
          this.pr,
          true // refresh = true
        );
        
      case "run_review":
        return await this.actionExecutor.executeReview(
          this.pr,
          this.provider,
          state
        );
        
      case "handle_pending":
        return await this.actionExecutor.executeHandlePending(this.pr);
        
      case "send_accepted":
        return await this.actionExecutor.executeSendAccepted(
          this.pr,
          this.provider
        );
        
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }
  
  private async handlePostAction(
    action: WorkflowAction,
    result: ActionResult,
    state: WorkflowState
  ): Promise<WorkflowAction | "show_menu"> {
    return await this.postActionHandler.handle(action, result, state);
  }
}
```

---

### Phase 6: Comment Resolution Manager Refactoring

#### 6.1 Split Responsibilities
**File:** `src/cli/managers/comment-resolution-manager.ts` (refactor)

**Current Issues:**
- `checkPendingComments()` does too much (checks + prompts + returns action)
- Mixing data retrieval with user interaction

**New Structure:**
```typescript
class CommentResolutionManager {
  // DATA RETRIEVAL (no prompts)
  async getCommentsState(prKey: string): Promise<{
    total: number;
    pending: number;
    accepted: number;
    fixed: number;
    rejected: number;
    comments: ReviewComment[];
  }>
  
  async getPendingComments(prKey: string): Promise<ReviewComment[]>
  
  async getAcceptedComments(prKey: string): Promise<ReviewComment[]>
  
  // EXECUTION (does the work)
  async handleComments(
    prKey: string,
    onFixRequested: (...) => Promise<void>,
    displayCommentFn: (...) => Promise<void>
  ): Promise<HandleCommentsResult>
  
  // HELPERS
  async saveCommentsToCache(...)
  async updateComment(...)
  displayResolutionSummary(...)
  // ... existing helper methods
}
```

---

### Phase 7: State Manager Implementation Details

#### 7.1 State Detection Logic
```typescript
async detectState(pr: PullRequest): Promise<WorkflowState> {
  const prKey = getPRKey(pr);
  const cacheInput = {
    sourceBranch: pr.source.name,
    targetBranch: pr.target.name,
  };
  
  // Check context
  const hasContext = this.cache.has(cacheInput);
  const contextMeta = hasContext ? this.cache.getMetadata(cacheInput) : undefined;
  const contextUpToDate = contextMeta?.gatheredFromCommit === pr.source.commitHash;
  
  // Check comments
  const commentsState = await this.commentResolution.getCommentsState(prKey);
  
  // Check for new commits (compare with last context/review)
  const hasNewCommits = contextMeta 
    ? contextMeta.gatheredFromCommit !== pr.source.commitHash
    : false;
  
  return {
    hasContext,
    contextUpToDate,
    contextMeta,
    hasComments: commentsState.total > 0,
    pendingCount: commentsState.pending,
    acceptedCount: commentsState.accepted,
    fixedCount: commentsState.fixed,
    rejectedCount: commentsState.rejected,
    hasRemoteComments: false, // Future
    remoteCommentsCount: 0,   // Future
    currentCommit: pr.source.commitHash,
    hasNewCommits,
  };
}
```

#### 7.2 Menu Generation Logic
```typescript
generateMenuOptions(
  state: WorkflowState,
  actions: WorkflowAction[]
): MenuOption[] {
  const options: MenuOption[] = [];
  
  for (const action of actions) {
    switch (action) {
      case "gather_context":
        if (!state.hasContext) {
          options.push({
            value: "gather_context",
            label: "🔍 Gather Deep Context",
            hint: "Fetch Jira/Confluence context (enables better review)",
            recommended: true,
          });
        }
        break;
        
      case "refresh_context":
        if (state.hasContext && !state.contextUpToDate) {
          options.push({
            value: "refresh_context",
            label: "🔄 Refresh Context",
            hint: `Context is outdated (from ${state.contextMeta?.gatheredFromCommit.substring(0, 8)})`,
            recommended: false,
          });
        }
        break;
        
      case "run_review":
        const hasWarning = !state.hasContext;
        options.push({
          value: "run_review",
          label: state.hasComments 
            ? "📝 Run New Review (merge with existing)" 
            : "📝 Run Review",
          hint: hasWarning 
            ? "⚠ No context - review will be limited" 
            : state.contextUpToDate
              ? "Analyze PR with up-to-date context"
              : "Analyze PR (context available but may be outdated)",
          recommended: state.hasContext && state.contextUpToDate && !state.hasComments,
          warningHint: hasWarning ? "No context available" : undefined,
        });
        break;
        
      case "handle_pending":
        options.push({
          value: "handle_pending",
          label: `🔧 Handle ${state.pendingCount} Pending Comment${state.pendingCount !== 1 ? 's' : ''}`,
          hint: "Review and resolve comments (fix, accept, or reject)",
          recommended: state.pendingCount > 0,
        });
        break;
        
      case "send_accepted":
        options.push({
          value: "send_accepted",
          label: `📤 Send ${state.acceptedCount} Accepted Comment${state.acceptedCount !== 1 ? 's' : ''}`,
          hint: "Post accepted comments to pull request",
          recommended: state.acceptedCount > 0 && state.pendingCount === 0,
        });
        break;
        
      case "exit":
        options.push({
          value: "exit",
          label: "✓ Exit",
          hint: "Save progress and exit",
        });
        break;
    }
  }
  
  return options;
}
```

---

## Implementation Steps

### Step 1: Foundation (No Breaking Changes)
- [ ] Create `src/cli/types.ts` with new type definitions
- [ ] Create `src/cli/managers/workflow-state-manager.ts`
- [ ] Implement state detection logic
- [ ] Implement menu option generation
- [ ] Add unit tests for state detection

### Step 2: Menu System
- [ ] Add `promptWorkflowMenu()` to `cli-prompts.ts`
- [ ] Style menu with proper theming
- [ ] Handle cancellation and edge cases
- [ ] Test menu rendering with various states

### Step 3: Action Executors
- [ ] Create `src/cli/managers/action-executor.ts`
- [ ] Extract context gathering logic from orchestrator
- [ ] Extract review execution logic
- [ ] Extract pending handling logic
- [ ] Extract accepted sending logic
- [ ] Each method should be self-contained and return result objects

### Step 4: Post-Action Handlers
- [ ] Create `src/cli/managers/post-action-handler.ts`
- [ ] Implement smart prompts for each action type
- [ ] Add logic to determine next action or show menu
- [ ] Test flow transitions

### Step 5: Comment Resolution Refactoring
- [ ] Split `checkPendingComments()` into data retrieval methods
- [ ] Create `getCommentsState()` method
- [ ] Create `getPendingComments()` method
- [ ] Create `getAcceptedComments()` method
- [ ] Update existing code to use new methods
- [ ] Remove old `checkPendingComments()` method

### Step 6: Main Orchestrator Refactoring
- [ ] Create `initialSetup()` method
- [ ] Create `menuLoop()` method
- [ ] Create `executeAction()` method
- [ ] Create `handlePostAction()` method
- [ ] Wire up all dependencies (state manager, action executor, post-action handler)
- [ ] Update constructor with new dependencies
- [ ] Remove old linear flow code
- [ ] Preserve cleanup logic

### Step 7: Integration & Testing
- [ ] Test all state transitions
- [ ] Test smart flows (context → review, review → handle, handle → send)
- [ ] Test menu returns
- [ ] Test exit at various points
- [ ] Test with various PR states (clean start, partial work, etc.)
- [ ] Update error handling

### Step 8: Dependency Injection Updates
- [ ] Update `src/index.ts` to instantiate new managers
- [ ] Wire up dependencies correctly
- [ ] Ensure singleton pattern where needed (cache, git operations)

---

## Migration Strategy

### Phase A: Parallel Implementation (Recommended)
1. Build new system alongside old code
2. Keep old `run()` method temporarily
3. Add new `runWithMenu()` method
4. Test extensively with `runWithMenu()`
5. Once stable, replace `run()` with `runWithMenu()`
6. Remove old code

### Phase B: Incremental Migration (Alternative)
1. Start by extracting action executors (non-breaking)
2. Add state manager (used but doesn't change flow)
3. Gradually replace linear flow with menu loop
4. Higher risk of breaking existing functionality

**Recommendation:** Use Phase A for safety

---

## File Structure Changes

### New Files
```
src/cli/
  ├── types.ts (NEW)
  ├── managers/
  │   ├── workflow-state-manager.ts (NEW)
  │   ├── action-executor.ts (NEW)
  │   └── post-action-handler.ts (NEW)
```

### Modified Files
```
src/cli/
  ├── orchestrator.ts (MAJOR REFACTOR)
  ├── cli-prompts.ts (ADD FUNCTIONS)
  └── managers/
      └── comment-resolution-manager.ts (REFACTOR)
```

---

## Risk Mitigation

### Potential Issues
1. **State Synchronization**: Cache updates must be atomic and consistent
2. **Infinite Loops**: Menu loop must have proper exit conditions
3. **Error Recovery**: Errors during actions should return to menu, not crash
4. **Signal Handling**: SIGINT/SIGTERM must work correctly in menu loop
5. **Branch Restoration**: Must work regardless of where user exits

### Solutions
1. Use cache transactions if possible, or ensure each update is complete
2. Always provide "exit" option, handle cancellations
3. Wrap action execution in try-catch, show errors, return to menu
4. Preserve signal handlers, call cleanup before exit
5. Keep cleanup in `finally` block, ensure it's idempotent

---

## Testing Strategy

### Unit Tests
- State detection with various cache/comment combinations
- Menu option generation for different states
- Action executors (mock dependencies)
- Post-action decision logic

### Integration Tests
- Full workflow: context → review → handle → send
- Partial workflows: skip context, handle existing comments
- Error scenarios: failed review, failed context gathering
- Cancellation at various points

### Manual Testing Scenarios
1. **Clean Start**: No cache, no comments
2. **Context Only**: Context cached, no review done
3. **Review Done**: Context + comments pending
4. **Partial Resolution**: Some comments handled, some pending
5. **All Accepted**: All comments accepted, need to send
6. **Outdated Context**: Context exists but PR has new commits
7. **Menu Navigation**: Move through all options without executing
8. **Smart Flow**: Accept all smart prompts and flow through
9. **Menu Returns**: Decline smart prompts, verify menu appears

---

## Success Criteria

### Functional Requirements
- ✅ State correctly detected after each action
- ✅ Menu shows only relevant options
- ✅ Recommendations guide user appropriately
- ✅ Smart flows work without showing menu unnecessarily
- ✅ User can always get back to menu
- ✅ Exit works from any point
- ✅ Branch cleanup happens reliably

### Non-Functional Requirements
- ✅ Code is modular and testable
- ✅ Clear separation of concerns
- ✅ Easy to add new actions in future
- ✅ Performance is acceptable (state detection < 100ms)
- ✅ Error messages are clear and actionable

### User Experience
- ✅ Workflow feels natural and efficient
- ✅ User is not annoyed by excessive prompts
- ✅ Recommendations are helpful
- ✅ Progress is preserved across interruptions
- ✅ User understands current state at all times

---

## Future Extensions

### Planned Features (Context for Architecture)

1. **Remote Comments Handling**
   - Detect comments from PR (Bitbucket API)
   - New action: `"handle_remote"`
   - Menu option: "💬 Review 5 Remote Comments"
   - Smart flow: Fetch → Review → Respond/Fix

2. **Batch Operations**
   - Multiple comment selection for batch fix/accept/reject
   - Requires menu change to multi-select for this action

3. **Review Templates**
   - Pre-configured review strategies (security, performance, style)
   - Menu option to select template before review

4. **Diff-Based Navigation**
   - Jump to specific files/hunks from comments
   - Integration with editor

5. **Comment Threading**
   - Reply to comments with fixes/explanations
   - Track conversation history

### Architecture Accommodations

- State detection is extensible (add new state properties)
- Menu generation is data-driven (easy to add options)
- Action executor uses switch/registry pattern (add new actions)
- Post-action handler can chain multiple smart flows
- Comment resolution already supports status tracking

---

## Timeline Estimate

**Total: ~20-25 hours of development + testing**

- Step 1 (Foundation): 3-4 hours
- Step 2 (Menu System): 2-3 hours
- Step 3 (Action Executors): 4-5 hours
- Step 4 (Post-Action): 2-3 hours
- Step 5 (Comment Refactor): 2-3 hours
- Step 6 (Orchestrator): 4-5 hours
- Step 7 (Integration & Testing): 3-4 hours
- Step 8 (DI Updates): 1 hour

---

## Open Questions

1. Should we show a "state summary" before the menu? (e.g., "Context: ✓ Up-to-date | Comments: 3 pending, 2 accepted")
2. Color coding for menu options? (Green for recommended, Yellow for warnings, etc.)
3. Keyboard shortcuts for common actions? (e.g., 'r' for review, 'h' for handle)
4. Should "exit" be at top or bottom of menu?
5. Display mode: Always show all options (grayed out if unavailable) or only show available?

---

## Notes for Implementation Agents

- Preserve all existing functionality during migration
- Keep git branch restoration logic intact
- Maintain cache structure compatibility
- Use existing theme/UI utilities consistently
- Follow existing error handling patterns
- Keep signal handlers (SIGINT/SIGTERM) working
- Write tests as you build each component
- Comment complex state logic thoroughly
- Use TypeScript strict mode
- Avoid any 'any' types in new code

---

## Appendix: State Transition Examples

### Example 1: Clean Start
```
State: No context, no comments
Menu: [⭐ Gather Context, Run Review (⚠ no context), Exit]
User: Gathers context
Smart Flow: "Run review now?" → Yes
State: Has context, has comments (pending)
Menu: [Handle Pending, Send Accepted (0), Run Review, Refresh Context, Exit]
User: Handle pending → Accept all
Smart Flow: "Send accepted?" → Yes
State: Has context, comments sent
Menu: [Run Review, Refresh Context, Exit]
```

### Example 2: Resume Work
```
State: Has outdated context, 5 pending comments
Menu: [⭐ Handle Pending, Refresh Context, Run Review, Exit]
User: Handle pending → Fix 3, Accept 2
Smart Flow: "Send accepted?" → No (show menu)
Menu: [Send Accepted (2), Run Review, Refresh Context, Exit]
User: Send accepted
Smart Flow: None (just show menu)
Menu: [Run Review, Refresh Context, Exit]
```

### Example 3: Review Without Context
```
State: No context, no comments
Menu: [⭐ Gather Context, Run Review (⚠ no context), Exit]
User: Run review (skips context)
Review completes with warnings, creates 3 comments
Smart Flow: "Handle comments now?" → No
Menu: [⭐ Handle Pending, Gather Context, Run Review, Exit]
```

---

## End of Plan
