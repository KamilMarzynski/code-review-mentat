import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type PromptConfig = {
	name: string;
	version: number | "latest";
};

export type PromptVariables = Record<string, string>;

export function createPromptLoader(baseDir: string) {
	const cache = new Map<string, string>();

	function resolveVersion(name: string, version: number | "latest"): number {
		if (version !== "latest") return version;

		const dir = join(baseDir, name);
		let files: string[];
		try {
			files = readdirSync(dir);
		} catch {
			throw new Error(`Prompt directory not found: ${name}`);
		}

		const versions = files
			.map((f) => f.match(/^v(\d+)\.md$/))
			.filter((m): m is RegExpMatchArray => m !== null)
			.map((m) => parseInt(m[1], 10));

		if (versions.length === 0) {
			throw new Error(`No version files found in prompt directory: ${name}`);
		}

		return Math.max(...versions);
	}

	function interpolate(content: string, variables: PromptVariables): string {
		return content.replace(/\{\{(\w+)\}\}/g, (_, key) => {
			if (!(key in variables)) {
				throw new Error(
					`Prompt placeholder {{${key}}} not supplied in variables`,
				);
			}
			return variables[key];
		});
	}

	return function loadPrompt(
		config: PromptConfig,
		variables: PromptVariables = {},
	): string {
		const version = resolveVersion(config.name, config.version);
		const cacheKey = `${config.name}:${version}`;

		let content = cache.get(cacheKey);
		if (content === undefined) {
			const filePath = join(baseDir, config.name, `v${version}.md`);
			content = readFileSync(filePath, "utf-8");
			cache.set(cacheKey, content);
		}

		return interpolate(content, variables);
	};
}

// Default loader — uses the prompts directory alongside this file.
// Import this in services; use createPromptLoader only in tests.
export const loadPrompt = createPromptLoader(import.meta.dir);
