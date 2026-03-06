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

export type CreateMemoryResult = {
	id: string;
	situation: string;
	lesson: string;
};

export type MemorySearchOptions = {
	maxDistance: number;
	limit?: number;
};

export type MemorySearchResult = {
	id: string;
	situation: string;
	lesson: string;
	fileExtension: string;
	projectName: string | null;
	severity: string;
	distance: number;
};

export type MemoryQueryInput = {
	context?: string;
	editedFiles: string[];
	commits: string[];
	diff: string;
	sourceBranch: string;
	targetBranch: string;
	exampleSituations?: string[];
};
