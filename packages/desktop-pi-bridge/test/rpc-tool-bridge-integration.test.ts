import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RpcPiAgentPort } from "../src/rpc-port.ts";

describe("Pi RPC tool bridge integration", () => {
	it("loads the real Pi extension and acknowledges dynamic tool generations", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-rpc-tools-"));
		const port = new RpcPiAgentPort({
			enableToolBridge: true,
			requestTimeoutMs: 15_000,
			toolBridgeExtensionPath: fileURLToPath(new URL("../src/tool-bridge-extension.ts", import.meta.url)),
		});
		try {
			const state = await port.start({
				cwd: directory,
				sessionDirectory: join(directory, "sessions"),
				agentDirectory: join(directory, "agent"),
				projectTrusted: true,
				skillDirectories: [],
				extensionPaths: [],
				env: {},
				sensitiveValues: [],
				models: [
					{
						providerId: "fake",
						displayName: "Fake",
						baseUrl: "http://127.0.0.1:9/v1",
						modelId: "fake-model",
						apiKey: null,
						capabilities: { streaming: true, toolCalling: true, thinking: false, multimodal: false },
					},
				],
				selectedModel: { providerId: "fake", modelId: "fake-model" },
				thinkingLevel: "off",
				runtimeId: "integration-runtime",
				tools: [
					{
						name: "desktop_echo",
						description: "Echo",
						parameters: { type: "object" },
						call: async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
					},
				],
			});
			expect(state.modelProvider).toBe("fake");
			await expect(
				port.setTools([
					{
						name: "desktop_second",
						description: "Second",
						parameters: { type: "object" },
						call: async () => ({ content: [{ type: "text", text: "ok" }] }),
					},
				]),
			).resolves.toBeUndefined();
		} finally {
			await port.stop();
		}
	}, 30_000);
});
