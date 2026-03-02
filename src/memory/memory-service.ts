import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { loadPrompt } from "../prompts/loader";
import { Embedder } from "./embedder";
import { LLMClient } from "./llm-client";
import { MemoryStore } from "./memory-store";
import type {
	CreateMemoryInput,
	CreateMemoryResult,
	MemorySearchOptions,
	MemorySearchResult,
	MemoryServiceConfig,
} from "./types";

export class MemoryService {
	private llm: LLMClient;
	private embedder: Embedder;
	private store: MemoryStore | null = null;
	private initialized = false;
	private config: MemoryServiceConfig;

	constructor(config: MemoryServiceConfig) {
		this.config = config;
		this.llm = new LLMClient(
			config.openRouterApiKey,
			config.model ?? "anthropic/claude-haiku-4-5",
		);
		this.embedder = new Embedder(config.embeddingModel);
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		await this.embedder.initialize();
		this.store = new MemoryStore(this.config.dbPath);
		this.store.initialize(this.embedder.getDimensions());
		this.initialized = true;
	}

	async createMemory(input: CreateMemoryInput): Promise<CreateMemoryResult> {
		await this.ensureInitialized();

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

		const embedding = await this.embedder.embed(situation);

		const id = randomUUID();
		const store = this.store;
		if (!store) {
			throw new Error("MemoryStore not initialized");
		}
		store.insert({
			id,
			situation,
			lesson,
			fileExtension: extname(input.file),
			projectName: input.projectName ?? null,
			file: input.file,
			severity: input.severity,
			embedding,
			createdAt: new Date().toISOString(),
		});

		return { id, situation, lesson };
	}

	async searchMemories(
		query: string | string[],
		options: MemorySearchOptions,
	): Promise<MemorySearchResult[]> {
		await this.ensureInitialized();

		const store = this.store;
		if (!store) {
			throw new Error("MemoryStore not initialized");
		}

		const queries = Array.isArray(query) ? query : [query];
		const allResults: MemorySearchResult[] = [];

		for (const q of queries) {
			const embedding = await this.embedder.embed(q);
			const results = store.search(embedding, options);
			allResults.push(...results);
		}

		// Deduplicate by ID, keeping best (lowest) distance
		const bestByID = new Map<string, MemorySearchResult>();
		for (const result of allResults) {
			const existing = bestByID.get(result.id);
			if (!existing || result.distance < existing.distance) {
				bestByID.set(result.id, result);
			}
		}

		const deduplicated = Array.from(bestByID.values());
		deduplicated.sort((a, b) => a.distance - b.distance);

		const limit = options.limit ?? 10;
		return deduplicated.slice(0, limit);
	}

	close(): void {
		this.store?.close();
	}
}
