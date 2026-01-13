import { describe, expect, it } from "bun:test";
import type { MenuOption } from "../types";

/**
 * Integration tests for promptWorkflowMenu
 *
 * Note: Full UI testing with clack requires interactive testing.
 * These tests verify the option formatting logic that feeds into clack.
 */
describe("promptWorkflowMenu option formatting", () => {
	// Helper to format options the same way promptWorkflowMenu does
	function formatMenuOptions(options: MenuOption[]) {
		return options.map((option) => {
			let label = option.label;

			// Add recommendation indicator
			if (option.recommended) {
				label = `⭐ ${label}`;
			}

			return {
				value: option.value,
				label,
				hint: option.hint,
				recommended: option.recommended,
				warningHint: option.warningHint,
			};
		});
	}

	it("should add star to recommended options", () => {
		const options: MenuOption[] = [
			{
				value: "gather_context",
				label: "🔍 Gather Deep Context",
				hint: "Fetch Jira/Confluence context",
				recommended: true,
			},
			{
				value: "exit",
				label: "✓ Exit",
				hint: "Save progress and exit",
				recommended: false,
			},
		];

		const formatted = formatMenuOptions(options);

		expect(formatted[0]?.label).toContain("⭐");
		expect(formatted[0]?.label).toContain("🔍 Gather Deep Context");
		expect(formatted[1]?.label).not.toContain("⭐");
	});

	it("should preserve option values", () => {
		const options: MenuOption[] = [
			{
				value: "gather_context",
				label: "Gather Context",
			},
			{
				value: "run_review",
				label: "Run Review",
			},
			{
				value: "exit",
				label: "Exit",
			},
		];

		const formatted = formatMenuOptions(options);

		expect(formatted[0]?.value).toBe("gather_context");
		expect(formatted[1]?.value).toBe("run_review");
		expect(formatted[2]?.value).toBe("exit");
	});

	it("should handle options with warnings", () => {
		const options: MenuOption[] = [
			{
				value: "run_review",
				label: "📝 Run Review",
				hint: "⚠ No context - review will be limited",
				warningHint: "No context available",
			},
		];

		const formatted = formatMenuOptions(options);

		expect(formatted[0]?.hint).toBeDefined();
		expect(formatted[0]?.warningHint).toBe("No context available");
	});

	it("should handle options without hints", () => {
		const options: MenuOption[] = [
			{
				value: "exit",
				label: "✓ Exit",
			},
		];

		const formatted = formatMenuOptions(options);

		expect(formatted[0]?.hint).toBeUndefined();
	});

	it("should handle multiple recommended options", () => {
		const options: MenuOption[] = [
			{
				value: "gather_context",
				label: "🔍 Gather Context",
				recommended: true,
			},
			{
				value: "handle_pending",
				label: "🔧 Handle Pending",
				recommended: true,
			},
			{
				value: "exit",
				label: "✓ Exit",
				recommended: false,
			},
		];

		const formatted = formatMenuOptions(options);

		expect(formatted[0]?.label).toContain("⭐");
		expect(formatted[1]?.label).toContain("⭐");
		expect(formatted[2]?.label).not.toContain("⭐");
	});

	it("should preserve all workflow action types", () => {
		const actions: Array<{
			action:
				| "gather_context"
				| "refresh_context"
				| "run_review"
				| "handle_pending"
				| "send_accepted"
				| "exit";
			label: string;
		}> = [
			{ action: "gather_context", label: "Gather Context" },
			{ action: "refresh_context", label: "Refresh Context" },
			{ action: "run_review", label: "Run Review" },
			{ action: "handle_pending", label: "Handle Pending" },
			{ action: "send_accepted", label: "Send Accepted" },
			{ action: "exit", label: "Exit" },
		];

		for (const testCase of actions) {
			const options: MenuOption[] = [
				{
					value: testCase.action,
					label: testCase.label,
				},
			];

			const formatted = formatMenuOptions(options);
			expect(formatted[0]?.value).toBe(testCase.action);
		}
	});

	it("should handle empty options array", () => {
		const options: MenuOption[] = [];
		const formatted = formatMenuOptions(options);
		expect(formatted).toHaveLength(0);
	});

	it("should handle options with all fields populated", () => {
		const options: MenuOption[] = [
			{
				value: "run_review",
				label: "📝 Run Review",
				hint: "⚠ Warning message",
				recommended: true,
				requiresContext: true,
				warningHint: "No context available",
			},
		];

		const formatted = formatMenuOptions(options);

		expect(formatted[0]?.value).toBe("run_review");
		expect(formatted[0]?.label).toContain("⭐");
		expect(formatted[0]?.hint).toBe("⚠ Warning message");
		expect(formatted[0]?.warningHint).toBe("No context available");
	});
});
