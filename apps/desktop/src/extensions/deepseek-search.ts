const REQUEST_TIMEOUT_MS = 30_000;

export interface DeepSeekSearchConfig {
	baseUrl: string;
	model: string;
	apiKey: string;
}

export interface DeepSeekSearchSource {
	title: string;
	url: string;
}

export interface DeepSeekSearchResult {
	summary: string;
	sources: DeepSeekSearchSource[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Build the Responses API request that asks DeepSeek to run its built-in web search. */
export function buildDeepSeekSearchRequest(
	config: DeepSeekSearchConfig,
	query: string,
): { url: string; init: RequestInit } {
	return {
		url: `${config.baseUrl.replace(/\/+$/, "")}/responses`,
		init: {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify({
				model: config.model,
				input: query,
				tools: [{ type: "web_search" }],
				tool_choice: { type: "web_search" },
				stream: false,
			}),
		},
	};
}

/** Extract the search summary and cited sources from a DeepSeek Responses API payload. */
export function parseDeepSeekSearchResponse(value: unknown): DeepSeekSearchResult {
	const record = isRecord(value) ? value : {};
	const error = isRecord(record.error) ? stringValue(record.error.message) : "";
	if (error) throw new Error(error);
	if (stringValue(record.status) === "failed") throw new Error("DeepSeek web search failed");
	const summaryParts: string[] = [];
	const sources: DeepSeekSearchSource[] = [];
	const items = Array.isArray(record.output) ? record.output : [];
	for (const item of items) {
		if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const part of item.content) {
			if (!isRecord(part)) continue;
			if (part.type === "output_text" && stringValue(part.text)) summaryParts.push(part.text as string);
			if (!Array.isArray(part.annotations)) continue;
			for (const annotation of part.annotations) {
				if (!isRecord(annotation) || typeof annotation.url !== "string" || !annotation.url) continue;
				const title = stringValue(annotation.title);
				sources.push({ title: title || annotation.url, url: annotation.url });
			}
		}
	}
	return { summary: summaryParts.join("\n"), sources };
}

export async function searchDeepSeek(
	config: DeepSeekSearchConfig,
	query: string,
	signal?: AbortSignal,
): Promise<DeepSeekSearchResult> {
	const { url, init } = buildDeepSeekSearchRequest(config, query);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}`);
		return parseDeepSeekSearchResponse(await response.json());
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}
