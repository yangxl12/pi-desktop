import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, "..", "..", "..");
const rendererDirectory = join(workspace, "apps", "desktop", "src", "renderer");
const lucideDirectory = join(workspace, "node_modules", "lucide", "dist", "esm");
const electronBinary = require("electron");
const electronHost = join(workspace, "apps", "desktop", "test", "e2e", "electron-renderer-host.cjs");
const outputDirectory = resolve(process.env.PI_DESKTOP_E2E_OUTPUT ?? join(workspace, ".pi-dev", "e2e-slash-menu"));

function state() {
	return {
		platform: "win32",
		window: { visible: true, minimized: false, maximized: false, closeToTray: true },
		projects: [
			{
				id: "project",
				name: "Slash fixture",
				rootPath: "C:/fixture",
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
				sessionPath: "C:/fixture/session.jsonl",
				title: "Slash menu fixture",
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
			runtimeId: "slash-fixture",
			status: "ready",
			isStreaming: false,
			thinkingLevel: "off",
			modelProvider: null,
			modelId: null,
			sessionPath: "C:/fixture/session.jsonl",
			messageCount: 0,
			lastError: null,
		},
		messages: [],
		models: [],
		commands: [
			{ name: "skill:review", description: "Review the current change", source: "skill", scope: "user" },
			{ name: "skill:rewrite", description: "Rewrite selected text", source: "skill", scope: "project" },
			{ name: "help", description: "Show help", source: "extension" },
		],
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
			locale: "en",
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
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
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

async function assertSlashMenu(page, name, width, height) {
	await page.setViewportSize({ width, height });
	await page.goto(process.env.PI_DESKTOP_E2E_URL, { timeout: 90_000 });
	const input = page.locator("#prompt-input");
	const menu = page.locator("#slash-menu");
	await input.waitFor();
	await input.fill("/skill:re");
	await menu.waitFor({ state: "visible" });
	assert.equal(await input.getAttribute("aria-expanded"), "true");
	assert.equal(await input.getAttribute("aria-controls"), "slash-menu");
	assert.equal(await menu.getAttribute("role"), "listbox");
	assert.equal(await menu.locator('[role="option"]').count(), 2);
	const initialActive = await input.getAttribute("aria-activedescendant");
	await input.press("ArrowDown");
	assert.notEqual(await input.getAttribute("aria-activedescendant"), initialActive);
	await input.press("Tab");
	assert.equal(await input.inputValue(), "/skill:rewrite ");
	assert.equal(await input.getAttribute("aria-expanded"), "false");

	await input.fill("/skill:re");
	await menu.waitFor({ state: "visible" });
	await input.press("Escape");
	assert.equal(await menu.isVisible(), false);

	await input.fill("/skill:re");
	await menu.waitFor({ state: "visible" });
	const first = menu.locator('[role="option"]').first();
	await first.hover();
	assert.equal(await first.getAttribute("aria-selected"), "true");

	const screenshotPath = join(outputDirectory, `slash-menu-${name}-${width}x${height}.png`);
	await page.screenshot({ path: screenshotPath, fullPage: false });
	const menuBox = await menu.boundingBox();
	const inputBox = await input.boundingBox();
	assert.ok(menuBox && inputBox, "slash menu and composer must have stable geometry");
	assert.ok(menuBox.y < inputBox.y, "slash menu must open above the composer");
	await first.click();
	assert.equal(await input.inputValue(), "/skill:review ");
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
const harness = await startHarness();
process.env.PI_DESKTOP_E2E_URL = harness.url;

try {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1220, height: 800 } });
		await assertSlashMenu(page, "chromium", 1220, 800);
		await assertSlashMenu(page, "chromium", 880, 600);
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
		await assertSlashMenu(page, "electron", 1220, 800);
		await assertSlashMenu(page, "electron", 880, 600);
	} finally {
		await electronBrowser?.close();
		await stopElectron(electronProcess);
	}
} finally {
	await harness.close();
}

console.log(`Slash menu Playwright screenshots: ${outputDirectory}`);
