import { describe, expect, it } from "vitest";
import { buildPiModelsJson } from "../src/rpc-port.ts";

describe("Pi model gateway adapter", () => {
	it("maps runtime-neutral capabilities and redacts keys to environment references", () => {
		const result = buildPiModelsJson({
			cwd: ".",
			sessionDirectory: ".",
			agentDirectory: ".",
			skillDirectories: [],
			extensionPaths: [],
			env: {},
			sensitiveValues: [],
			models: [
				{
					providerId: "local",
					displayName: "Local",
					baseUrl: "http://127.0.0.1:11434/v1",
					modelId: "qwen",
					apiKey: "secret-value",
					protocol: "local",
					capabilities: { streaming: true, toolCalling: false, thinking: false, multimodal: false },
				},
			],
			thinkingLevel: "off",
			runtimeId: "runtime",
		});
		const parsed = JSON.parse(result.content) as {
			providers: Record<string, { apiKey: string; models: Array<{ reasoning: boolean }> }>;
		};
		expect(parsed.providers.local.apiKey).toBe("$PI_DESKTOP_API_KEY_LOCAL");
		expect(parsed.providers.local.models[0].reasoning).toBe(false);
		expect(result.content).not.toContain("secret-value");
		expect(result.env.PI_DESKTOP_API_KEY_LOCAL).toBe("secret-value");
	});
});
