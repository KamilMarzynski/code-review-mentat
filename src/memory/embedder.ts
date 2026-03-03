import type { FeatureExtractionPipeline } from "@xenova/transformers";

const DEFAULT_MODEL = "mixedbread-ai/mxbai-embed-large-v1";
const DIMENSIONS = 1024;

export class Embedder {
	private pipeline: FeatureExtractionPipeline | null = null;

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

		// Feature extraction with normalize returns Float32Array data,
		// but Tensor.data is typed as a broad DataArray union
		return new Float32Array(output.data as ArrayLike<number>);
	}

	getDimensions(): number {
		return DIMENSIONS;
	}
}
