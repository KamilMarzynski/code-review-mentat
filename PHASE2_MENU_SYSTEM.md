# Phase 2: Menu System - Implementation Summary

## Overview

Phase 2 implements a dynamic, context-aware menu system that displays workflow options based on the current state. The menu provides visual feedback through recommendations, hints, and warnings to guide users through the optimal workflow.

## Implementation

### New Components

#### 1. `promptWorkflowMenu()` Function
**File:** [`src/cli/cli-prompts.ts`](../cli-prompts.ts)

A new prompt function that displays workflow menu options with rich formatting:

```typescript
async function promptWorkflowMenu(
  options: MenuOption[]
): Promise<WorkflowAction>
```

**Features:**
- ⭐ Recommendation indicators for suggested actions
- 💬 Contextual hints for each option
- ⚠️ Warning styling for suboptimal actions
- 🎨 Theme-consistent styling using existing UI utilities
- 🚫 Graceful cancellation handling (Ctrl+C)

#### 2. Menu Option Formatting Tests
**File:** [`src/cli/__tests__/cli-prompts.test.ts`](../__tests__/cli-prompts.test.ts)

Comprehensive tests covering:
- Recommendation star (⭐) addition
- Option value preservation
- Warning hint handling
- Empty and fully-populated options
- All workflow action types

#### 3. Integration Example
**File:** [`src/cli/examples/menu-workflow-example.ts`](../examples/menu-workflow-example.ts)

Reference implementation showing:
- State detection → Menu generation → Action execution loop
- Example menu outputs for various scenarios
- Integration pattern for Phase 6

## How It Works

### Menu Generation Flow

```
WorkflowState
    ↓
getAvailableActions()
    ↓
generateMenuOptions()
    ↓
promptWorkflowMenu()  ← Phase 2 Implementation
    ↓
User Selection
```

### Option Formatting Logic

```typescript
// 1. Add recommendation star if flagged
if (option.recommended) {
  label = `⭐ ${label}`;
}

// 2. Style label based on recommendation
label = option.recommended ? theme.primary(label) : label;

// 3. Format hint with appropriate styling
if (warningHint && hint) {
  hint = theme.warning(hint);  // Orange for warnings
} else if (recommended && hint) {
  hint = theme.success(hint);  // Green for recommendations
} else if (hint) {
  hint = theme.muted(hint);    // Gray for neutral
}
```

### Example Menu Outputs

#### Scenario 1: Clean Start
```
? What would you like to do?
  ⭐ 🔍 Gather Deep Context
     Fetch Jira/Confluence context (enables better review)
  
  📝 Run Review
     ⚠ No context - review will be limited
  
  ✓ Exit
     Save progress and exit
```

#### Scenario 2: Review Complete, Pending Comments
```
? What would you like to do?
  ⭐ 🔧 Handle 5 Pending Comments
     Review and resolve comments (fix, accept, or reject)
  
  📝 Run New Review (merge with existing)
     Analyze PR with up-to-date context
  
  ✓ Exit
     Save progress and exit
```

#### Scenario 3: Ready to Send
```
? What would you like to do?
  ⭐ 📤 Send 3 Accepted Comments
     Post accepted comments to pull request
  
  📝 Run Review
     Analyze PR with up-to-date context
  
  ✓ Exit
     Save progress and exit
```

## Integration Points

### With Phase 1 (State Detection)
The menu system consumes `MenuOption[]` from `WorkflowStateManager.generateMenuOptions()`:

```typescript
const stateManager = new WorkflowStateManager(cache);
const state = await stateManager.detectState(pr);
const actions = stateManager.getAvailableActions(state);
const options = stateManager.generateMenuOptions(state, actions);

// Phase 2 takes over here
const selectedAction = await promptWorkflowMenu(options);
```

### With Future Phases

**Phase 3 (Action Executors):**
```typescript
const selectedAction = await promptWorkflowMenu(options);
await actionExecutor.execute(selectedAction);
```

**Phase 4 (Post-Action Handlers):**
```typescript
const selectedAction = await promptWorkflowMenu(options);
const result = await actionExecutor.execute(selectedAction);
const nextAction = await postActionHandler.handle(selectedAction, result);
```

**Phase 6 (Main Orchestrator):**
Full integration in the menu loop:
```typescript
while (shouldContinue) {
  const state = await stateManager.detectState(pr);
  const actions = stateManager.getAvailableActions(state);
  const options = stateManager.generateMenuOptions(state, actions);
  const action = await promptWorkflowMenu(options);  // ← Phase 2
  
  if (action === "exit") break;
  
  await executeAction(action);
}
```

## Design Decisions

### 1. Visual Hierarchy
- **Recommended actions:** Gold/primary color + ⭐
- **Normal actions:** Default color
- **Warnings:** Orange color + ⚠️ in hint

### 2. Consistency
- Uses existing `@clack/prompts` library (same as other prompts)
- Follows existing `theme` utilities for colors
- Matches existing prompt patterns in the codebase

### 3. User Experience
- Clear visual distinction between recommended and optional actions
- Contextual hints explain what each action does
- Warnings alert users to suboptimal choices
- Graceful cancellation with Ctrl+C

### 4. Type Safety
- Returns strongly-typed `WorkflowAction`
- Accepts strongly-typed `MenuOption[]`
- Full TypeScript inference throughout

## Testing Strategy

### Unit Tests
- ✅ Option formatting (stars, hints, warnings)
- ✅ Value preservation
- ✅ All action types supported
- ✅ Edge cases (empty arrays, fully populated options)

### Integration Testing
- Reference implementation in `examples/` directory
- Can be manually tested before Phase 6 integration
- Shows expected behavior for all scenarios

### Manual Testing
Testing checklist for Phase 6 integration:
- [ ] Menu displays correctly in terminal
- [ ] Recommendations are visually distinct
- [ ] Warnings show in orange
- [ ] Ctrl+C exits gracefully
- [ ] All action types selectable
- [ ] Theme colors render correctly

## Backward Compatibility

✅ **Fully backward compatible:**
- New function added, no existing functions modified
- Existing prompts continue to work unchanged
- Can be integrated incrementally
- No breaking changes to existing code

## File Changes

### New Files
- `src/cli/__tests__/cli-prompts.test.ts` - Unit tests
- `src/cli/examples/menu-workflow-example.ts` - Integration example

### Modified Files
- `src/cli/cli-prompts.ts` - Added `promptWorkflowMenu()` function

## Metrics

- **Lines Added:** ~200 (including tests and examples)
- **Tests Added:** 8 test cases, 23 assertions
- **Functions Added:** 1 (`promptWorkflowMenu`)
- **Test Coverage:** All formatting logic paths tested

## Next Steps

### Phase 3: Action Executors
The menu system is ready. Next steps:
1. Extract action handlers from orchestrator
2. Create `ActionExecutor` class
3. Implement execution methods for each action
4. Wire up menu selections to action execution

### Integration Checklist
Before Phase 6 integration:
- [x] Phase 1: State detection infrastructure
- [x] Phase 2: Menu system
- [ ] Phase 3: Action executors
- [ ] Phase 4: Post-action handlers
- [ ] Phase 5: Comment resolution refactoring
- [ ] Phase 6: Main orchestrator refactoring

## References

- [PLAN.md](../../../PLAN.md) - Complete refactoring plan
- [Phase 1 README](../managers/WORKFLOW_STATE_README.md) - State detection docs
- [cli-prompts.ts](../cli-prompts.ts) - Implementation
- [Example Integration](../examples/menu-workflow-example.ts) - Usage reference

## Notes

- Menu styling uses existing theme system for consistency
- Cancellation (Ctrl+C) exits cleanly with exit code 0
- All workflow actions supported (6 action types)
- Extensible: new actions just need to be added to the enum
- Ready for Phase 3 integration
