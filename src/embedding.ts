export class EmbeddingClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.openai.com/v1",
    private readonly headers: Record<string, string> = {},
  ) {}

  async embed(text: string): Promise<number[]> {
    const baseUrl = this.baseUrl.replace(/\/+$/, "");
    const endpoint = baseUrl.endsWith("/embeddings") ? baseUrl : `${baseUrl}/embeddings`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        ...this.headers,
      },
      body: JSON.stringify({ model: this.model, input: text, encoding_format: "float" }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    let payload: { data?: Array<{ embedding?: number[] }>; error?: { message?: string } };
    try {
      payload = JSON.parse(body) as typeof payload;
    } catch {
      if (!response.ok) throw new Error(`Embedding API ${response.status} at ${endpoint} for model ${this.model}: ${body.slice(0, 500) || response.statusText}`);
      throw new Error("Embedding API returned an invalid JSON response");
    }
    if (!response.ok) throw new Error(`Embedding API ${response.status} at ${endpoint} for model ${this.model}: ${payload.error?.message || body.slice(0, 500) || "request failed"}`);
    const vector = payload.data?.[0]?.embedding;
    if (!vector?.length) throw new Error("Embedding API returned no vector");
    return vector;
  }
}