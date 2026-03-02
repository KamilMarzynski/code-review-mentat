const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

export class LLMClient {
	private baseUrl = "https://openrouter.ai/api/v1";

	constructor(
		private apiKey: string,
		private model: string = DEFAULT_MODEL,
	) {}

	async complete(systemPrompt: string, userMessage: string): Promise<string> {
		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userMessage },
				],
				temperature: 0,
			}),
		});

		if (!response.ok) {
			const body = await response.text();
			throw new Error(`OpenRouter API error ${response.status}: ${body}`);
		}

		const data = await response.json();
		const content = data.choices?.[0]?.message?.content;

		if (typeof content !== "string" || content.length === 0) {
			throw new Error("OpenRouter returned empty response");
		}

		return content;
	}
}
