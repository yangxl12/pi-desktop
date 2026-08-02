import { describe, expect, it } from "vitest";
import { ConsentBroker } from "../src/index.ts";

describe("consent broker", () => {
	it("resolves pending consent and persists project decisions", async () => {
		const broker = new ConsentBroker({ timeoutMs: 500 });
		let requestId = "";
		const unsubscribe = broker.subscribe((event) => {
			if (event.type === "consent.required") requestId = event.request.requestId;
		});
		const pending = broker.request({ serverId: "server", toolName: "echo", projectId: "project" });
		expect(broker.respond(requestId, true, "project")).toBe(true);
		expect(await pending).toBe(true);
		unsubscribe();
		expect(await broker.request({ serverId: "server", toolName: "echo", projectId: "project" })).toBe(true);
	});
});
