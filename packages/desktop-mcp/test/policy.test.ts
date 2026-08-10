import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentBroker, FileToolPolicyStore } from "../src/index.ts";

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

	it("persists project decisions, keeps session decisions local, and revokes grants", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-consent-"));
		const path = join(directory, "policy.json");
		const first = new FileToolPolicyStore(path);
		first.set("project", "server.echo", "allow", "project");
		first.set("project", "server.write", "allow", "session");

		const reopened = new FileToolPolicyStore(path);
		expect(reopened.get("project", "server.echo")).toBe("allow");
		expect(reopened.get("project", "server.write")).toBeNull();
		reopened.revoke("project", "server.echo");
		expect(new FileToolPolicyStore(path).get("project", "server.echo")).toBeNull();
	});
});
