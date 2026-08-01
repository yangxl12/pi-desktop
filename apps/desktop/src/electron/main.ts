import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, shell, Tray } from "electron";

const port = 4317;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let host: ChildProcess | null = null;
let quitting = false;

function resourcePath(...parts: string[]): string {
	return join(process.resourcesPath, ...parts);
}

function trayIcon(): Electron.NativeImage {
	const size = 16;
	const buffer = Buffer.alloc(size * size * 4);
	for (let y = 2; y < 14; y += 1) {
		for (let x = 2; x < 14; x += 1) {
			const index = (y * size + x) * 4;
			const border = x < 4 || x > 11 || y < 4 || y > 11;
			buffer[index] = border ? 31 : 248;
			buffer[index + 1] = border ? 41 : 250;
			buffer[index + 2] = border ? 55 : 252;
			buffer[index + 3] = 255;
		}
	}
	return nativeImage.createFromBuffer(buffer, { width: size, height: size });
}

async function waitForHost(): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/state`);
			if (response.ok) return;
		} catch {}
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
	}
	throw new Error("Pi Desktop background service did not start");
}

function startHost(): void {
	const executable = process.execPath;
	const args = [resourcePath("app", "host.mjs")];
	host = spawn(executable, args, {
		windowsHide: true,
		env: {
			...process.env,
			ELECTRON_RUN_AS_NODE: "1",
			PI_DESKTOP_PORT: String(port),
			PI_DESKTOP_RPC_ENTRY: resourcePath("app", "rpc-entry.mjs"),
			PI_PACKAGE_DIR: resourcePath("app"),
			PI_DESKTOP_RENDERER_DIR: resourcePath("app", "renderer"),
			PI_DESKTOP_LUCIDE_DIR: resourcePath("app", "lucide"),
		},
		stdio: "ignore",
	});
	host.once("exit", () => {
		host = null;
		if (!quitting) void showWindow();
	});
}

async function showWindow(): Promise<void> {
	if (!window) return;
	if (!host) startHost();
	try {
		await waitForHost();
		if (window.webContents.getURL() !== `http://127.0.0.1:${port}/`)
			await window.loadURL(`http://127.0.0.1:${port}/`);
	} catch (error: unknown) {
		await window.loadURL(
			`data:text/html;charset=utf-8,${encodeURIComponent(`<h1>Pi Desktop failed to start</h1><pre>${error instanceof Error ? error.message : String(error)}</pre>`)}`,
		);
	}
	window.show();
	if (window.isMinimized()) window.restore();
	window.focus();
}

function createWindow(): void {
	window = new BrowserWindow({
		width: 1220,
		height: 800,
		minWidth: 880,
		minHeight: 600,
		show: false,
		backgroundColor: "#f7f8fa",
		title: "Pi Desktop",
		webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
	});
	window.removeMenu();
	window.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		window?.hide();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith("https://")) void shell.openExternal(url);
		return { action: "deny" };
	});
}

function createTray(): void {
	tray = new Tray(trayIcon());
	tray.setToolTip("Pi Desktop");
	tray.setContextMenu(
		Menu.buildFromTemplate([
			{ label: "Open", click: () => void showWindow() },
			{ label: "Settings", click: () => void showWindow() },
			{ type: "separator" },
			{
				label: "Quit",
				click: () => {
					quitting = true;
					app.quit();
				},
			},
		]),
	);
	tray.on("double-click", () => void showWindow());
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
	app.on("second-instance", () => void showWindow());
	app.on("before-quit", () => {
		quitting = true;
	});
	app.on("will-quit", () => {
		globalShortcut.unregisterAll();
		if (host && !host.killed) host.kill();
	});
	void app.whenReady().then(async () => {
		app.setAppUserModelId("works.earendil.pi.desktop");
		createWindow();
		createTray();
		globalShortcut.register("CommandOrControl+Shift+0", () => {
			if (window?.isVisible()) window.hide();
			else void showWindow();
		});
		startHost();
		await showWindow();
	});
}
