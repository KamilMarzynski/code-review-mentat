export type MemoryServiceConfig = {
	dbPath: string;
	openRouterApiKey: string;
	model?: string;
	embeddingModel?: string;
};

export type CreateMemoryInput = {
	file: string;
	severity: string;
	code: string;
	comment: string;
	additionalContext?: string;
	projectName?: string;
};

export type MemoryDocument = {
	id: string;
	situation: string;
	lesson: string;
	fileExtension: string;
	projectName: string | null;
	file: string;
	severity: string;
	embedding: Float32Array;
	createdAt: string;
};

export type CreateMemoryResult = {
	id: string;
	situation: string;
	lesson: string;
};
