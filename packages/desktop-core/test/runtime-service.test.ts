import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type AgentRuntimeProvider,
	DEFAULT_RUNTIME_CAPABILITIES,
	FakeAgentRuntime,
	RuntimeProviderRegistry,
	RuntimeService,
} from "../src/index.ts";

function provider(id: string, response: string): AgentRuntimeProvider {
	return {
		manifest: { id, version: "test", capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES } },
		create: () => new FakeAgentRuntime({ response }),
	};
}

describe("runtime provider registry and service", () => {
	it("starts the default provider and serializes replacement", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-runtime-service-"));
		const registry = new RuntimeProviderRegistry();
		registry.register(provider("first", "one"), { isDefault: true });
		registry.register(provider("second", "two"));
		const service = new RuntimeService(registry);
		const options = {
			cwd: root,
			sessionDirectory: root,
			agentDirectory: root,
			skillDirectories: [],
			extensionPaths: [],
			env: {},
			sensitiveValues: [],
			models: [],
			thinkingLevel: "high" as const,
			runtimeId: "runtime-1",
		};
		await service.start(options);
		await service.prompt("hello");
		expect((await service.getMessages()).at(-1)?.parts[0]?.text).toBe("one");
		await service.start({ ...options, runtimeId: "runtime-2", providerId: "second" });
		await service.prompt("hello");
		expect((await service.getMessages()).at(-1)?.parts[0]?.text).toBe("two");
		expect(service.snapshot.providerId).toBe("second");
	});
});
