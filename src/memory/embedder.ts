const DEFAULT_MODEL = "mxbai-embed-large";
const DIMENSIONS = 1024;

export class Embedder {
	private baseUrl = "http://localhost:11434/v1";

	constructor(private model: string = DEFAULT_MODEL) {}

	async embed(text: string): Promise<Float32Array> {
		const response = await fetch(`${this.baseUrl}/embeddings`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: this.model,
				input: text,
			}),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`Embeddings error ${response.status}: ${body}`);
		}

		const data = (await response.json()) as {
			data?: { embedding?: number[]; index: number }[];
		};
		const embedding = data.data?.[0]?.embedding;

		if (!embedding || embedding.length === 0) {
			throw new Error("Embeddings API returned empty embedding");
		}

		return new Float32Array(embedding);
	}

	getDimensions(): number {
		return DIMENSIONS;
	}
}
