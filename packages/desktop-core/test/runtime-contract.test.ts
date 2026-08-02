import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CAPABILITIES, FakeAgentRuntime, normalizeRuntimeCapabilities } from "../src/index.ts";

describe("runtime-neutral contract", () => {
	it("supports ready, streaming, abort and opaque session refs without Pi imports", async () => {
		const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-runtime-contract-"));
		const runtime = new FakeAgentRuntime({ response: "ok" });
		const events: string[] = [];
		runtime.subscribe((event) => events.push(event.type));
		const state = await runtime.start({
			cwd: sessionDirectory,
			sessionDirectory,
			agentDirectory: sessionDirectory,
			skillDirectories: [],
			extensionPaths: [],
			env: {},
			sensitiveValues: [],
			models: [],
			thinkingLevel: "high",
			runtimeId: "contract-runtime",
		});
		expect(state.sessionRef).toBe(state.sessionPath);
		expect(state.capabilities?.streaming).toBe(true);
		await runtime.prompt("hello");
		expect(events).toContain("ready");
		expect(events).toContain("message_delta");
		await runtime.abort();
		const next = await runtime.newSession();
		expect(next.sessionRef).not.toBe(state.sessionRef);
	});

	it("merges provider capability overrides over safe defaults", () => {
		expect(normalizeRuntimeCapabilities({ toolCalling: true, multimodal: true })).toEqual({
			...DEFAULT_RUNTIME_CAPABILITIES,
			toolCalling: true,
			multimodal: true,
		});
	});
});
