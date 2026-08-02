import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_RESULTS = 8;
const REQUEST_TIMEOUT_MS = 20_000;

interface SearchSource {
	title: string;
	url: string;
	snippet: string;
	publishedAt?: string;
}

function textResult(text: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function formatSources(provider: string, sources: SearchSource[]): string {
	if (sources.length === 0) return `No ${provider} search results were found.`;
	return [
		`Web search results from ${provider}:`,
		...sources.map((source, index) => {
			const date = source.publishedAt ? ` (${source.publishedAt})` : "";
			return `${index + 1}. ${source.title}${date}\n   ${source.url}\n   ${source.snippet}`;
		}),
	].join("\n");
}

async function fetchJson(url: string, init: RequestInit, signal: AbortSignal): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}

async function searchBrave(
	query: string,
	maxResults: number,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchSource[]> {
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(maxResults));
	url.searchParams.set("safesearch", "moderate");
	const result = (await fetchJson(
		url.toString(),
		{
			headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
		},
		signal,
	)) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> } };
	return (result.web?.results ?? [])
		.filter((item) => item.title && item.url)
		.map((item) => ({
			title: item.title ?? "Untitled result",
			url: item.url ?? "",
			snippet: item.description ?? "",
			publishedAt: item.age,
		}));
}

async function searchTavily(
	query: string,
	maxResults: number,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchSource[]> {
	const result = (await fetchJson(
		"https://api.tavily.com/search",
		{
			method: "POST",
			headers: { "content-type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, search_depth: "basic" }),
		},
		signal,
	)) as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
	return (result.results ?? [])
		.filter((item) => item.title && item.url)
		.map((item) => ({
			title: item.title ?? "Untitled result",
			url: item.url ?? "",
			snippet: item.content ?? "",
			publishedAt: item.published_date,
		}));
}

export default function webSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description: "Search current public web information and return source URLs with snippets.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 500, description: "The web search query" }),
			maxResults: Type.Optional(
				Type.Integer({ minimum: 1, maximum: MAX_RESULTS, description: "Number of results" }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			const maxResults = params.maxResults ?? 5;
			const requestSignal = signal ?? new AbortController().signal;
			const braveKey = process.env.BRAVE_SEARCH_API_KEY;
			const tavilyKey = process.env.TAVILY_API_KEY;
			if (!braveKey && !tavilyKey) {
				return textResult(
					"Web search is not configured. Ask the user to add a Brave Search or Tavily API key in Pi Desktop settings.",
					{ provider: "disabled" },
				);
			}
			try {
				const provider = braveKey ? "Brave Search" : "Tavily";
				const sources = braveKey
					? await searchBrave(query, maxResults, braveKey, requestSignal)
					: await searchTavily(query, maxResults, tavilyKey ?? "", requestSignal);
				return textResult(formatSources(provider, sources), { provider, query, sources });
			} catch (error: unknown) {
				return textResult(`Web search failed: ${error instanceof Error ? error.message : String(error)}`, {
					provider: braveKey ? "brave" : "tavily",
					query,
				});
			}
		},
	});
}
