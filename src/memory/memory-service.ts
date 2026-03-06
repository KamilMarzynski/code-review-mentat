import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import {
	AgentMemories,
	OpenAICompatibleEmbedder,
	SqliteStore,
} from "agent-memories";
import { loadPrompt } from "../prompts/loader";
import { LLMClient } from "./llm-client";
import type {
	CreateMemoryInput,
	CreateMemoryResult,
	MemorySearchOptions,
	MemorySearchResult,
	MemoryServiceConfig,
} from "./types";

export class MemoryService {
	private llm: LLMClient;
	private memories: AgentMemories;
	private dbPath: string;

	constructor(config: MemoryServiceConfig) {
		this.dbPath = config.dbPath;
		this.llm = new LLMClient(
			config.openRouterApiKey,
			config.model ?? "anthropic/claude-haiku-4-5",
		);
		this.memories = new AgentMemories({
			store: new SqliteStore({
				path: config.dbPath,
				filterableFields: ["severity", "fileExtension"],
			}),
			embedder: new OpenAICompatibleEmbedder({
				model: config.embeddingModel ?? "mxbai-embed-large",
			}),
		});
	}

	async createMemory(input: CreateMemoryInput): Promise<CreateMemoryResult> {
		const additionalContext = input.additionalContext ?? "None provided";

		const situationPrompt = loadPrompt(
			{ name: "memory-situation", version: "latest" },
			{
				file: input.file,
				severity: input.severity,
				code: input.code,
				comment: input.comment,
				additional_context: additionalContext,
			},
		);
		const situation = await this.llm.complete(
			situationPrompt,
			"Generate the situation.",
		);

		const lessonPrompt = loadPrompt(
			{ name: "memory-lesson", version: "latest" },
			{
				situation,
				comment: input.comment,
				additional_context: additionalContext,
			},
		);
		const lesson = await this.llm.complete(
			lessonPrompt,
			"Generate the lesson.",
		);

		const id = randomUUID();
		await this.memories.insert({
			id,
			embedText: situation,
			data: {
				situation,
				lesson,
				fileExtension: extname(input.file),
				projectName: input.projectName ?? null,
				file: input.file,
				severity: input.severity,
			},
		});

		return { id, situation, lesson };
	}

	async searchMemories(
		query: string | string[],
		options: MemorySearchOptions,
	): Promise<MemorySearchResult[]> {
		const queries = Array.isArray(query) ? query : [query];

		const results = await this.memories.searchMultiple(queries, {
			maxDistance: options.maxDistance,
			limit: options.limit,
		});

		return results.map((r) => ({
			id: r.id,
			situation: r.data.situation as string,
			lesson: r.data.lesson as string,
			fileExtension: r.data.fileExtension as string,
			projectName: (r.data.projectName as string | null) ?? null,
			severity: r.data.severity as string,
			distance: r.distance,
		}));
	}

	getRandomSituations(limit = 5): string[] {
		if (!existsSync(this.dbPath)) {
			return [];
		}

		const db = new Database(this.dbPath, { readonly: true });
		try {
			const stmt = db.prepare(
				"SELECT json_extract(data, '$.situation') as situation FROM memories ORDER BY RANDOM() LIMIT ?",
			);
			const rows = stmt.all(limit) as Array<{ situation: string }>;
			return rows.map((row) => row.situation);
		} finally {
			db.close();
		}
	}

	async close(): Promise<void> {
		await this.memories.close();
	}
}
