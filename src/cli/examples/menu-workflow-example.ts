import type LocalCache from "../../cache/local-cache";
import type { PullRequest } from "../../git-providers/types";
import { promptWorkflowMenu } from "../cli-prompts";
import { WorkflowStateManager } from "../managers/workflow-state-manager";

/**
 * Example integration demonstrating the menu system with state detection
 *
 * This shows how Phase 1 (State Detection) and Phase 2 (Menu System)
 * work together to provide a dynamic workflow.
 *
 * This is NOT production code - it's a reference implementation
 * to demonstrate the architecture before Phase 6 (Full Integration).
 */
export async function exampleMenuWorkflow(
	pr: PullRequest,
	cache: LocalCache,
): Promise<void> {
	const stateManager = new WorkflowStateManager(cache);

	// Example loop (simplified - actual implementation in Phase 6)
	let shouldContinue = true;

	while (shouldContinue) {
		// 1. Detect current state
		const state = await stateManager.detectState(pr);

		// 2. Get available actions based on state
		const actions = stateManager.getAvailableActions(state);

		// 3. Generate menu options with contextual hints
		const options = stateManager.generateMenuOptions(state, actions);

		// 4. Show menu and get user choice
		const selectedAction = await promptWorkflowMenu(options);

		// 5. Handle the action
		switch (selectedAction) {
			case "gather_context":
				console.log("➡️ Gathering context...");
				// TODO: Call context gathering logic
				break;

			case "refresh_context":
				console.log("➡️ Refreshing context...");
				// TODO: Call context refresh logic
				break;

			case "run_review":
				console.log("➡️ Running review...");
				// TODO: Call review logic
				break;

			case "handle_pending":
				console.log(`➡️ Handling ${state.pendingCount} pending comments...`);
				// TODO: Call comment handling logic
				break;

			case "send_accepted":
				console.log(`➡️ Sending ${state.acceptedCount} accepted comments...`);
				// TODO: Call send comments logic
				break;

			case "handle_remote":
				console.log("➡️ Handling remote comments...");
				// TODO: Future feature - call remote comment handling logic
				break;

			case "exit":
				console.log("👋 Exiting...");
				shouldContinue = false;
				break;

			default: {
				// TypeScript exhaustiveness check
				const _exhaustive: never = selectedAction;
				throw new Error(`Unknown action: ${_exhaustive}`);
			}
		}

		// Loop continues with fresh state detection
	}
}

/**
 * Example: Menu output scenarios
 *
 * These examples show what the menu looks like in different states.
 * Actual output will be styled with colors from the theme.
 */

// Scenario 1: Clean start (no context, no comments)
// ```
// ? What would you like to do?
//   ⭐ 🔍 Gather Deep Context
//      Fetch Jira/Confluence context (enables better review)
//
//   📝 Run Review
//      ⚠ No context - review will be limited
//
//   ✓ Exit
//      Save progress and exit
// ```

// Scenario 2: Context gathered, no review yet
// ```
// ? What would you like to do?
//   ⭐ 📝 Run Review
//      Analyze PR with up-to-date context
//
//   ✓ Exit
//      Save progress and exit
// ```

// Scenario 3: Review complete, pending comments
// ```
// ? What would you like to do?
//   ⭐ 🔧 Handle 5 Pending Comments
//      Review and resolve comments (fix, accept, or reject)
//
//   📝 Run New Review (merge with existing)
//      Analyze PR with up-to-date context
//
//   ✓ Exit
//      Save progress and exit
// ```

// Scenario 4: Comments handled, ready to send
// ```
// ? What would you like to do?
//   ⭐ 📤 Send 3 Accepted Comments
//      Post accepted comments to pull request
//
//   📝 Run Review
//      Analyze PR with up-to-date context
//
//   ✓ Exit
//      Save progress and exit
// ```

// Scenario 5: Outdated context, pending comments
// ```
// ? What would you like to do?
//   ⭐ 🔧 Handle 2 Pending Comments
//      Review and resolve comments (fix, accept, or reject)
//
//   🔄 Refresh Context
//      Context is outdated (from abc123de)
//
//   📝 Run Review
//      Analyze PR (context available but may be outdated)
//
//   ✓ Exit
//      Save progress and exit
// ```
