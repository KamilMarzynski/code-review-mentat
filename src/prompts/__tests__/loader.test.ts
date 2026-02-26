import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPromptLoader } from "../loader";

describe("PromptLoader", () => {
	let tmpDir: string;
	let loadPrompt: ReturnType<typeof createPromptLoader>;

	beforeAll(() => {
		tmpDir = mkdtempSync("/tmp/prompt-loader-test-");

		// Prompt with two versions and a variable
		mkdirSync(join(tmpDir, "test-prompt"));
		writeFileSync(join(tmpDir, "test-prompt", "v1.md"), "Hello {{name}}!");
		writeFileSync(join(tmpDir, "test-prompt", "v2.md"), "Hello v2 {{name}}!");

		// Static prompt with no variables
		mkdirSync(join(tmpDir, "static-prompt"));
		writeFileSync(join(tmpDir, "static-prompt", "v1.md"), "No variables here.");

		loadPrompt = createPromptLoader(tmpDir);
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true });
	});

	test("loads latest version (highest integer) when version is 'latest'", () => {
		const result = loadPrompt(
			{ name: "test-prompt", version: "latest" },
			{ name: "World" },
		);
		expect(result).toBe("Hello v2 World!");
	});

	test("loads a specific version when a number is given", () => {
		const result = loadPrompt(
			{ name: "test-prompt", version: 1 },
			{ name: "World" },
		);
		expect(result).toBe("Hello World!");
	});

	test("works with no variables for a static prompt", () => {
		const result = loadPrompt({ name: "static-prompt", version: "latest" });
		expect(result).toBe("No variables here.");
	});

	test("throws a descriptive error when a placeholder is not supplied", () => {
		expect(() => loadPrompt({ name: "test-prompt", version: 1 }, {})).toThrow(
			"Prompt placeholder {{name}} not supplied in variables",
		);
	});

	test("throws when the prompt directory does not exist", () => {
		expect(() =>
			loadPrompt({ name: "nonexistent", version: "latest" }),
		).toThrow("Prompt directory not found: nonexistent");
	});

	test("throws when a specific version number does not exist", () => {
		expect(() => loadPrompt({ name: "test-prompt", version: 99 })).toThrow(
			"Prompt version v99 not found for: test-prompt",
		);
	});

	test("caches file content — re-reads return the original value", () => {
		// Load once to prime the cache
		const result1 = loadPrompt({ name: "static-prompt", version: 1 });
		// Overwrite the file on disk — cache should prevent picking up the change
		writeFileSync(join(tmpDir, "static-prompt", "v1.md"), "Modified content.");
		const result2 = loadPrompt({ name: "static-prompt", version: 1 });
		expect(result1).toBe(result2);
		expect(result2).toBe("No variables here.");
	});
});
