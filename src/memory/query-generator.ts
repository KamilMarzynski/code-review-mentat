import { loadPrompt } from "../prompts/loader";
import type { LLMClient } from "./llm-client";
import type { MemoryQueryInput } from "./types";

export class MemoryQueryGenerator {
	constructor(private llm: LLMClient) {}

	async generateQueries(input: MemoryQueryInput): Promise<string[]> {
		const prompt = loadPrompt(
			{ name: "memory-query", version: "latest" },
			{
				context: input.context ?? "No context gathered.",
				editedFiles: input.editedFiles.map((f) => `- ${f}`).join("\n"),
				commits: input.commits.map((c) => `- ${c}`).join("\n"),
				diff: input.diff,
				sourceBranch: input.sourceBranch,
				targetBranch: input.targetBranch,
			},
		);

		const response = await this.llm.complete(
			prompt,
			"Generate memory search queries.",
		);

		return this.parseQueries(response);
	}

	private parseQueries(response: string): string[] {
		const jsonMatch = response.match(/\[[\s\S]*\]/);
		if (!jsonMatch) {
			throw new Error("Failed to parse query response: no JSON array found");
		}

		const parsed = JSON.parse(jsonMatch[0]);
		if (!Array.isArray(parsed)) {
			throw new Error("Failed to parse query response: not an array");
		}

		return parsed.filter(
			(item): item is string => typeof item === "string" && item.length > 0,
		);
	}
}
