import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const execFile = promisify(execFileCallback);

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const rendererDirectory = join(workspace, "apps", "desktop", "src", "renderer");
const lucideDirectory = join(workspace, "node_modules", "lucide", "dist", "esm");
const electronBinary = require("electron");
const electronHost = join(workspace, "apps", "desktop", "test", "e2e", "electron-renderer-host.cjs");
const fixtureDirectory = await mkdtemp(join(tmpdir(), "pi-preview-fixture-"));

const buildResult = await execFile(process.execPath, [join(here, "build-file-viewer.mjs")], {
	cwd: join(here, ".."),
	windowsHide: true,
});
// Freshly written bundles can be locked by real-time AV scanning on Windows;
// the first read blocks until the scan completes. Only needed after a real build.
if (!buildResult.stdout.includes("(up to date)")) await delay(3500);

await writeFile(join(fixtureDirectory, "notes.md"), "# 预览测试\n\n这是 markdown 内容。\n\n```js\nconst answer = 42;\n```\n");
await writeFile(join(fixtureDirectory, "page.html"), "<!doctype html><html><body><h1 id=\"page-title\">HTML 页面</h1></body></html>");
await writeFile(
	join(fixtureDirectory, "chart.png"),
	Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

function state() {
	return {
		platform: "win32",
		window: { visible: true, minimized: false, maximized: false, closeToTray: true },
		projects: [
			{
				id: "project",
				name: "Preview fixture",
				rootPath: fixtureDirectory,
				trustState: "trusted",
				createdAt: "2026-08-05T00:00:00.000Z",
				updatedAt: "2026-08-05T00:00:00.000Z",
				lastOpenedAt: "2026-08-05T00:00:00.000Z",
			},
		],
		activeProjectId: "project",
		conversations: [
			{
				id: "session",
				projectId: "project",
				sessionPath: join(fixtureDirectory, "session.jsonl"),
				title: "Preview fixture",
				createdAt: "2026-08-05T00:00:00.000Z",
				updatedAt: "2026-08-05T00:00:00.000Z",
				modelProvider: null,
				modelId: null,
				thinkingLevel: "off",
				leafId: null,
				status: "idle",
			},
		],
		activeSessionId: "session",
		runtime: {
			projectId: "project",
			sessionId: "session",
			runtimeId: "preview-fixture",
			status: "ready",
			isStreaming: false,
			thinkingLevel: "off",
			modelProvider: null,
			modelId: null,
			sessionPath: join(fixtureDirectory, "session.jsonl"),
			messageCount: 1,
			lastError: null,
		},
		messages: [
			{
				id: "assistant-1",
				role: "assistant",
				parts: [
					{ type: "text", text: "已生成 [notes.md](notes.md) 和 [页面](page.html)，以及 [图片](chart.png)。" },
					{
						type: "tool",
						text: "Successfully wrote 12 bytes to notes.md",
						toolName: "write",
						toolCallId: "call-1",
						status: "finished",
					},
				],
				createdAt: "2026-08-05T00:00:00.000Z",
				status: "finished",
			},
		],
		models: [],
		commands: [],
		skillInstallations: [],
		mcpServers: [],
		mcpTools: [],
		consentRequests: [],
		approvalRequests: [],
		runtimeTools: { desiredGeneration: 0, appliedGeneration: 0, toolNames: [], lastError: null },
		settings: {
			globalSystemPrompt: "",
			invokeShortcut: "Alt+Shift+O",
			defaultModelProfileId: null,
			defaultThinkingLevel: "off",
			conversationFontSize: 16,
			sidebarFontSize: 14,
			closeToTray: true,
			skillDirectories: [],
			locale: "zh-CN",
			theme: "dark",
			webSearch: { provider: "disabled", credentialRef: null },
			schemaVersion: 5,
		},
		diagnostics: [],
	};
}

function contentType(pathname) {
	if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
	if (pathname.endsWith(".js") || pathname.endsWith(".mjs")) return "text/javascript; charset=utf-8";
	return "text/html; charset=utf-8";
}

function resolveStatic(root, requested) {
	const candidate = resolve(root, requested);
	if (relative(root, candidate).startsWith("..")) throw new Error("Forbidden static path");
	return candidate;
}

async function startHarness() {
	const openResponses = new Set();
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const pathname = url.pathname;
		if (pathname === "/api/state") {
			response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			response.end(JSON.stringify(state()));
			return;
		}
		if (pathname === "/api/command") {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				let command = {};
				try {
					command = JSON.parse(body).command ?? {};
				} catch {}
				const data = command.type === "sessions.listAll" ? { project: state().conversations } : null;
				response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
				response.end(JSON.stringify({ requestId: "e2e", success: true, data }));
			});
			return;
		}
		if (pathname === "/api/events") {
			response.writeHead(200, {
				"cache-control": "no-cache",
				connection: "keep-alive",
				"content-type": "text/event-stream; charset=utf-8",
			});
			response.write(": connected\n\n");
			openResponses.add(response);
			request.once("close", () => openResponses.delete(response));
			return;
		}
		if (pathname === "/api/file") {
			const filePath = resolveStatic(fixtureDirectory, decodeURIComponent(url.searchParams.get("path") ?? ""));
			response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
			response.end(await readFile(filePath));
			return;
		}
		try {
			const isLucide = pathname.startsWith("/vendor/lucide/");
			const filePath = isLucide
				? resolveStatic(lucideDirectory, decodeURIComponent(pathname.slice("/vendor/lucide/".length)))
				: resolveStatic(rendererDirectory, pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)));
			response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
			response.end(await readFile(filePath));
		} catch {
			if (!response.headersSent) response.writeHead(404).end("Not found");
		}
	});
	await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("E2E fixture did not bind a TCP port");
	return {
		url: `http://127.0.0.1:${address.port}`,
		async close() {
			for (const response of openResponses) response.end();
			await new Promise((resolveServer) => server.close(resolveServer));
		},
	};
}

async function reserveLoopbackPort() {
	const server = createServer();
	await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("E2E CDP port did not bind");
	await new Promise((resolveServer) => server.close(resolveServer));
	return address.port;
}

async function waitForCdp(port, process) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (process.exitCode !== null) throw new Error(`Electron E2E host exited with code ${process.exitCode}`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			if (response.ok) return;
		} catch {}
		await delay(100);
	}
	throw new Error("Electron E2E host did not expose CDP in time");
}

async function waitForElectronPage(browser) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url() !== "about:blank");
		if (page) return page;
		await delay(100);
	}
	throw new Error("Electron E2E host did not create a renderer page in time");
}

async function stopElectron(process) {
	if (process.exitCode !== null) return;
	process.kill();
	await Promise.race([once(process, "exit"), delay(5_000)]);
}

async function assertPreview(page, label) {
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(`console: ${message.text()}`);
	});
	page.on("response", (response) => {
		if (response.status() >= 400) pageErrors.push(`http ${response.status()}: ${response.url()}`);
	});
	await page.goto(process.env.PI_DESKTOP_E2E_URL, { timeout: 90_000 });

	const panel = page.locator("#preview-panel");
	await page.locator(".message.assistant").waitFor();

	// Chip from the tool result; anchors from the markdown links
	assert.equal(await page.locator(".file-chip").count(), 1, "one preview chip from the tool result");
	const chipNames = await page.locator(".file-chip span").allTextContents();
	assert.ok(chipNames.includes("notes.md"), `chip names include notes.md: ${chipNames.join(",")}`);
	assert.equal(await page.locator('.markdown-body a[data-action="preview-file"]').count(), 3, "markdown preview links");

	// Open the markdown file from the chip
	await page.locator('.file-chip[data-file-path="notes.md"]').click();
	await panel.waitFor({ state: "visible" });
	await page.locator(".ofv-root").waitFor({ timeout: 30_000 });
	await page.locator(".ofv-markdown-body").waitFor({ timeout: 30_000 });
	assert.match(await page.locator(".ofv-markdown-body").innerText(), /预览测试/);
	const panelBox = await panel.boundingBox();
	assert.ok(panelBox && panelBox.width > 0 && panelBox.width < 900, "panel is the split half");

	// Markdown link target opens the HTML page in the sandboxed iframe
	await page.locator('.markdown-body a[data-action="preview-file"][data-file-path="page.html"]').click();
	const frame = page.frameLocator("iframe.preview-html-frame");
	await frame.locator("#page-title").waitFor({ timeout: 30_000 });
	assert.equal(await frame.locator("#page-title").innerText(), "HTML 页面");
	assert.equal(await page.locator(".preview-html-frame").getAttribute("sandbox"), "allow-scripts");

	// Image preview via the markdown link
	await page.locator('.markdown-body a[data-action="preview-file"][data-file-path="chart.png"]').click();
	await page.locator(".ofv-root img").waitFor({ timeout: 30_000 });

	// Fullscreen mode
	await page.locator('[data-action="preview-toggle-fullscreen"]').click();
	assert.ok(await panel.evaluate((element) => element.classList.contains("fullscreen")), "fullscreen class applied");
	await page.locator('[data-action="preview-toggle-fullscreen"]').click();
	assert.equal(await panel.evaluate((element) => element.classList.contains("fullscreen")), false, "fullscreen class removed");

	// Close
	await page.locator('[data-action="preview-close"]').click();
	await panel.waitFor({ state: "hidden" });
	assert.equal(await page.locator(".ofv-root").count(), 0, "viewer destroyed on close");

	assert.deepEqual(pageErrors, [], `no renderer errors for ${label}`);
}

const harness = await startHarness();
process.env.PI_DESKTOP_E2E_URL = harness.url;

try {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
		await assertPreview(page, "chromium");
	} finally {
		await browser.close();
	}

	const cdpPort = await reserveLoopbackPort();
	const electronEnvironment = { ...process.env, PI_DESKTOP_E2E_URL: harness.url };
	delete electronEnvironment.ELECTRON_RUN_AS_NODE;
	const electronProcess = spawn(electronBinary, [`--remote-debugging-port=${cdpPort}`, electronHost], {
		cwd: workspace,
		env: electronEnvironment,
		stdio: "ignore",
		windowsHide: true,
	});
	let electronBrowser;
	try {
		await waitForCdp(cdpPort, electronProcess);
		electronBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
		const page = await waitForElectronPage(electronBrowser);
		await assertPreview(page, "electron");
	} finally {
		await electronBrowser?.close();
		await stopElectron(electronProcess);
	}
} finally {
	await harness.close();
	await rm(fixtureDirectory, { recursive: true, force: true });
}

console.log("File preview e2e passed for chromium and electron");
