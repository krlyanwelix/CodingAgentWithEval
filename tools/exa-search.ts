import type { Tool } from "../src/types.js";

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  highlights?: string[];
  text?: string;
}

interface ExaResponse {
  results?: ExaResult[];
  error?: string;
}

function objectArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("tool arguments must be an object");
  }
  return args as Record<string, unknown>;
}

export const tool: Tool = {
  definition: {
    name: "exa_search",
    description: "Search the web with Exa and return relevant current pages, titles, URLs, and excerpts.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The web search query" },
        numResults: { type: "integer", minimum: 1, maximum: 10, description: "Number of results, default 5" },
        type: { type: "string", enum: ["auto", "neural", "fast", "deep"], description: "Exa search mode" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },

  async execute(args): Promise<string> {
    const apiKey = (globalThis as typeof globalThis & {
      process?: { env?: Record<string, string | undefined> };
    }).process?.env?.EXA_API_KEY;
    if (!apiKey) return "EXA_API_KEY is not configured. Add it to .env and restart the agent.";

    const input = objectArgs(args);
    if (typeof input.query !== "string" || input.query.trim() === "") throw new Error("query must be a non-empty string");
    const numResults = typeof input.numResults === "number" ? Math.min(10, Math.max(1, Math.floor(input.numResults))) : 5;
    const searchType = input.type === "neural" || input.type === "fast" || input.type === "deep" ? input.type : "auto";

    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        query: input.query,
        type: searchType,
        numResults,
        contents: { highlights: { maxCharacters: 2000 } },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json() as ExaResponse;
    if (!response.ok) throw new Error(`Exa API ${response.status}: ${payload.error ?? "request failed"}`);

    const results = payload.results ?? [];
    if (results.length === 0) return "No web results found.";
    return results.map((result, index) => {
      const excerpt = result.highlights?.join(" ") || result.text?.slice(0, 2000) || "No excerpt";
      return `${index + 1}. ${result.title ?? "Untitled"}\nURL: ${result.url ?? ""}${result.publishedDate ? `\nPublished: ${result.publishedDate}` : ""}\n${excerpt}`;
    }).join("\n\n");
  },
};
