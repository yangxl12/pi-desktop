import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("serves project files through /api/file with traversal and size guards", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-preview-"));
		writeFileSync(join(directory, "notes.md"), "# 笔记\n\n预览内容");
		writeFileSync(join(directory, "page.html"), "<h1>Hello</h1>");
		writeFileSync(join(directory, "secret.txt"), "top secret");
		mkdirSync(join(directory, "nested"));
		writeFileSync(join(directory, "nested", "image.svg"), "<svg/>");
		const app = appStub();
		app.state = {
			ready: true,
			projects: [{ id: "p1", rootPath: directory, trustState: "trusted" }],
		};
		const gateway = createDesktopHostHttpServer({ app, hostToken: "test-token", port: 4317 });
		gateway.server.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => gateway.server.once("listening", () => resolve()));
		const port = (gateway.server.address() as AddressInfo).port;
		const base = { "x-pi-desktop-token": "test-token" };
		const fetchFile = (params: string, method: "GET" | "HEAD" = "GET") =>
			fetch(`http://127.0.0.1:${port}/api/file?${params}`, { method, headers: base });

		const missing = await fetchFile("projectId=p1&path=nope.md");
		expect(missing.status).toBe(404);

		const unknownProject = await fetchFile("projectId=nope&path=notes.md");
		expect(unknownProject.status).toBe(404);

		const missingParams = await fetchFile("projectId=p1");
		expect(missingParams.status).toBe(400);

		const traversal = await fetchFile("projectId=p1&path=..%2F..%2F..%2Fwindows%2Fwin.ini");
		expect(traversal.status).toBe(403);

		const absolute = await fetchFile(`projectId=p1&path=${encodeURIComponent(join(directory, "secret.txt"))}`);
		expect(absolute.status).toBe(400);

		const markdown = await fetchFile("projectId=p1&path=notes.md");
		expect(markdown.status).toBe(200);
		expect(markdown.headers.get("content-type")).toContain("text/markdown");
		expect(markdown.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await markdown.text()).toContain("# 笔记");

		const html = await fetchFile("projectId=p1&path=page.html");
		expect(html.status).toBe(200);
		expect(html.headers.get("content-type")).toContain("text/html");

		const nested = await fetchFile("projectId=p1&path=nested%2Fimage.svg");
		expect(nested.status).toBe(200);
		expect(nested.headers.get("content-type")).toContain("image/svg+xml");

		const head = await fetchFile("projectId=p1&path=notes.md", "HEAD");
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toContain("text/markdown");
		expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("# 笔记\n\n预览内容")));
		expect(head.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await head.text()).toBe("");

		const headMissing = await fetchFile("projectId=p1&path=nope.md", "HEAD");
		expect(headMissing.status).toBe(404);

		await gateway.close();
	});
});
