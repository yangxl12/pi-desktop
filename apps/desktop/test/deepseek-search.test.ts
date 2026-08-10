import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildDeepSeekSearchRequest,
	parseDeepSeekSearchResponse,
	searchDeepSeek,
} from "../src/extensions/deepseek-search.ts";
import webSearchExtension from "../src/extensions/web-search.ts";

const CONFIG = { baseUrl: "https://api.deepseek.com/", model: "deepseek-v4-flash", apiKey: "sk-test" };

function searchPayload(summary: string, citations: Array<{ title: string; url: string }>) {
	return {
		id: "resp-1",
		status: "completed",
		output: [
			{ type: "web_search_call", id: "ws_1", status: "completed" },
			{
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [
					{
						type: "output_text",
						text: summary,
						annotations: citations.map((citation, index) => ({
							type: "url_citation",
							start_index: 0,
							end_index: 1,
							title: citation.title,
							url: citation.url,
						})),
					},
				],
			},
		],
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("PI_DESKTOP_WEB_SEARCH_") || key === "BRAVE_SEARCH_API_KEY" || key === "TAVILY_API_KEY")
			delete process.env[key];
	}
});

describe("deepseek search", () => {
	it("builds a Responses API request that forces the built-in web search tool", () => {
		const { url, init } = buildDeepSeekSearchRequest(CONFIG, "latest Pi release");
		expect(url).toBe("https://api.deepseek.com/responses");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			"content-type": "application/json",
			authorization: "Bearer sk-test",
		});
		const body = JSON.parse(String(init.body)) as Record<string, unknown>;
		expect(body).toEqual(
			expect.objectContaining({
				model: "deepseek-v4-flash",
				input: "latest Pi release",
				stream: false,
				tools: [{ type: "web_search" }],
				tool_choice: { type: "web_search" },
			}),
		);
	});

	it("extracts the summary and cited sources from a completed response", () => {
		const result = parseDeepSeekSearchResponse(
			searchPayload("DeepSeek released v4.", [
				{ title: "DeepSeek blog", url: "https://api-docs.deepseek.com/news" },
			]),
		);
		expect(result.summary).toBe("DeepSeek released v4.");
		expect(result.sources).toEqual([
			{ title: "DeepSeek blog", url: "https://api-docs.deepseek.com/news" },
		]);
	});

	it("throws on provider errors and failed responses", () => {
		expect(() =>
			parseDeepSeekSearchResponse({ error: { message: "model does not support web search" } }),
		).toThrow("model does not support web search");
		expect(() => parseDeepSeekSearchResponse({ status: "failed", error: { message: "boom" } })).toThrow("boom");
		expect(() => parseDeepSeekSearchResponse({ status: "failed" })).toThrow("DeepSeek web search failed");
	});

	it("performs the search over fetch and surfaces HTTP failures", async () => {
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => searchPayload("v4 is out.", []),
		}));
		vi.stubGlobal("fetch", fetchMock);
		const result = await searchDeepSeek(CONFIG, "deepseek v4");
		expect(result.summary).toBe("v4 is out.");
		expect(fetchMock).toHaveBeenCalledOnce();

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 400 })),
		);
		await expect(searchDeepSeek(CONFIG, "deepseek v4")).rejects.toThrow("HTTP 400");
	});

	it("uses the DeepSeek built-in search when the host configures it", async () => {
		process.env.PI_DESKTOP_WEB_SEARCH_PROVIDER = "deepseek";
		process.env.PI_DESKTOP_WEB_SEARCH_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
		process.env.PI_DESKTOP_WEB_SEARCH_DEEPSEEK_MODEL = "deepseek-v4-flash";
		process.env.PI_DESKTOP_WEB_SEARCH_DEEPSEEK_API_KEY = "sk-test";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				status: 200,
				json: async () =>
					searchPayload("Summary.", [
						{ title: "Result one", url: "https://example.test/1" },
						{ title: "Result two", url: "https://example.test/2" },
					]),
			})),
		);
		const tools: Array<{
			name: string;
			execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ text?: string }> }>;
		}> = [];
		webSearchExtension({
			registerTool: (tool) => {
				tools.push(tool as never);
			},
		} as never);
		const tool = tools.find((candidate) => candidate.name === "web_search");
		expect(tool).toBeDefined();
		const result = await tool!.execute("call-1", { query: "latest news", maxResults: 8 });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Summary.");
		expect(text).toContain("Result one");
		expect(text).toContain("https://example.test/1");
	});

	it("reports when no web search provider is configured", async () => {
		const tools: Array<{
			name: string;
			execute(toolCallId: string, params: Record<string, unknown>): Promise<{ content: Array<{ text?: string }> }>;
		}> = [];
		webSearchExtension({
			registerTool: (tool) => {
				tools.push(tool as never);
			},
		} as never);
		const tool = tools.find((candidate) => candidate.name === "web_search");
		const result = await tool!.execute("call-1", { query: "latest news" });
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Web search is not configured");
	});
});
