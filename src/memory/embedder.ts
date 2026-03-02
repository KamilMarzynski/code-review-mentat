const DEFAULT_MODEL = "mixedbread-ai/mxbai-embed-large-v1";
const DIMENSIONS = 1024;

export class Embedder {
	private pipeline: any | null = null;

	constructor(private modelName: string = DEFAULT_MODEL) {}

	async initialize(): Promise<void> {
		const { pipeline } = await import("@xenova/transformers");
		this.pipeline = await pipeline("feature-extraction", this.modelName);
	}

	async embed(text: string): Promise<Float32Array> {
		if (!this.pipeline) {
			throw new Error("Embedder not initialized. Call initialize() first.");
		}

		const output = await this.pipeline(text, {
			pooling: "cls",
			normalize: true,
		});

		return new Float32Array(output.data);
	}

	getDimensions(): number {
		return DIMENSIONS;
	}
}
