import { describe, expect, it } from "vitest";
import { MemorySecretStore, ModelGateway, PerformanceMetrics } from "../src/index.ts";

describe("model gateway and performance metrics", () => {
	it("resolves capabilities and credentials only for the runtime boundary", async () => {
		const secrets = new MemorySecretStore();
		const ref = await secrets.set("top-secret", "secret:model");
		const gateway = new ModelGateway(secrets);
		const profile = {
			id: "model",
			providerId: "local",
			displayName: "Local",
			baseUrl: "http://127.0.0.1:11434/v1",
			modelId: "qwen",
			credentialRef: ref,
			protocol: "local" as const,
			capabilities: { streaming: true, toolCalling: false, thinking: false, multimodal: false, contextWindow: 8192 },
			enabled: true,
			createdAt: "2026-08-02T00:00:00.000Z",
			updatedAt: "2026-08-02T00:00:00.000Z",
		};
		expect(gateway.describe(profile).profile.credentialRef).toBe(ref);
		expect((await gateway.resolve(profile)).apiKey).toBe("top-secret");
		expect(gateway.describe(profile).capabilities.contextWindow).toBe(8192);
	});

	it("keeps bounded latency samples and calculates p95", async () => {
		const metrics = new PerformanceMetrics(10);
		metrics.record("state", 0);
		metrics.record("state", 0);
		expect(metrics.snapshot("state")).toMatchObject({
			count: 2,
			averageMs: expect.any(Number),
			p95Ms: expect.any(Number),
		});
		await expect(metrics.measure("command", () => "ok")).resolves.toMatchObject({
			value: "ok",
			metric: { name: "command" },
		});
	});
});
