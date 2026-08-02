import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createDesktopHostHttpServer } from "../src/host/http-gateway.ts";

function appStub() {
	const listeners = new Set<(event: unknown) => void>();
	return {
		state: { ready: true },
		getState() {
			return this.state;
		},
		dispatch: async (_command: unknown, requestId = "request") => ({ requestId, success: true, data: { ok: true } }),
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		publish(event: unknown) {
			for (const listener of listeners) listener(event);
		},
	};
}

describe("desktop host HTTP gateway", () => {
	it("requires the host token and bootstraps a same-origin cookie", async () => {
		const app = appStub();
		const gateway = createDesktopHostHttpServer({
			app,
			hostToken: "test-token",
			port: 4317,
			staticHandler: async (_pathname, response) => response.end("ok"),
		});
		gateway.server.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => gateway.server.once("listening", () => resolve()));
		const port = (gateway.server.address() as AddressInfo).port;
		const root = await fetch(`http://127.0.0.1:${port}/`);
		expect(root.status).toBe(200);
		const cookie = root.headers.get("set-cookie");
		expect(cookie).toContain("pi_desktop_token=test-token");
		const unauthorized = await fetch(`http://127.0.0.1:${port}/api/state`);
		expect(unauthorized.status).toBe(401);
		const authorized = await fetch(`http://127.0.0.1:${port}/api/state`, {
			headers: { cookie: cookie?.split(";", 1)[0] ?? "" },
		});
		expect(authorized.status).toBe(200);
		expect(await authorized.json()).toEqual({ ready: true });
		await gateway.close();
	});

	it("rejects cross-origin commands and invalid content types", async () => {
		const app = appStub();
		const gateway = createDesktopHostHttpServer({ app, hostToken: "test-token", port: 4317, limits: { maxBodyBytes: 8 } });
		gateway.server.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => gateway.server.once("listening", () => resolve()));
		const port = (gateway.server.address() as AddressInfo).port;
		const base = { "x-pi-desktop-token": "test-token" };
		const origin = await fetch(`http://127.0.0.1:${port}/api/command`, {
			method: "POST",
			headers: { ...base, origin: "https://evil.example", "content-type": "application/json" },
			body: JSON.stringify({ requestId: "r1", command: { type: "app.getState" } }),
		});
		expect(origin.status).toBe(403);
		const contentType = await fetch(`http://127.0.0.1:${port}/api/command`, {
			method: "POST",
			headers: base,
			body: "{}",
		});
		expect(contentType.status).toBe(415);
		const oversized = await fetch(`http://127.0.0.1:${port}/api/command`, {
			method: "POST",
			headers: { ...base, "content-type": "application/json" },
			body: JSON.stringify({ requestId: "too-large", command: { type: "app.getState" } }),
		});
		expect(oversized.status).toBe(413);
		await gateway.close();
	});
});
