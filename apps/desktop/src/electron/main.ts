import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, shell, Tray } from "electron";
import {
	type ElectronShellEvent,
	type ElectronShellRequest,
	type ElectronShellResponse,
	isElectronShellRequest,
} from "../shared/electron-shell-ipc.ts";

const port = 4317;
const hostToken = randomBytes(32).toString("hex");
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let host: ChildProcess | null = null;
let registeredShortcut: string | undefined;
let closeToTray = true;
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

function currentWindowState() {
	return {
		visible: window?.isVisible() ?? false,
		minimized: window?.isMinimized() ?? false,
		maximized: window?.isMaximized() ?? false,
		closeToTray,
	};
}

function sendToHost(message: ElectronShellEvent | ElectronShellResponse): void {
	if (!host?.connected) return;
	try {
		host.send(message);
	} catch {
		// The host exited between the connected check and message dispatch.
	}
}

function publishWindowState(): void {
	sendToHost({
		type: "pi-desktop.shell.event",
		token: hostToken,
		event: "window.changed",
		state: currentWindowState(),
	});
}

function revealWindow(): void {
	if (!window) return;
	if (window.isMinimized()) window.restore();
	window.show();
	window.focus();
}

function toggleWindow(): void {
	if (!window) return;
	if (window.isVisible()) window.hide();
	else revealWindow();
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
			PI_DESKTOP_HOST_TOKEN: hostToken,
			PI_DESKTOP_RPC_ENTRY: resourcePath("app", "rpc-entry.mjs"),
			PI_PACKAGE_DIR: resourcePath("app"),
			PI_DESKTOP_RENDERER_DIR: resourcePath("app", "renderer"),
			PI_DESKTOP_LUCIDE_DIR: resourcePath("app", "lucide"),
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	host.on("message", (message: unknown) => void handleHostMessage(message));
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
	revealWindow();
}

function requestQuit(): void {
	if (host?.connected) {
		sendToHost({ type: "pi-desktop.shell.event", token: hostToken, event: "tray.action", action: "quit" });
		return;
	}
	quitting = true;
	app.quit();
}

function handleTrayAction(action: "open" | "settings" | "quit"): void {
	if (action === "quit") {
		requestQuit();
		return;
	}
	if (host?.connected) {
		sendToHost({ type: "pi-desktop.shell.event", token: hostToken, event: "tray.action", action });
		return;
	}
	void showWindow();
}

async function handleHostMessage(value: unknown): Promise<void> {
	if (!isElectronShellRequest(value) || value.token !== hostToken) return;
	const respond = (success: boolean, state = currentWindowState(), error?: string): void => {
		const message: ElectronShellResponse = {
			type: "pi-desktop.shell.response",
			id: value.id,
			token: hostToken,
			success,
			state,
			...(error ? { error } : {}),
		};
		sendToHost(message);
	};
	try {
		switch (value.operation) {
			case "window.getState":
				break;
			case "window.show":
				revealWindow();
				break;
			case "window.hide":
				window?.hide();
				break;
			case "window.toggle":
				toggleWindow();
				break;
			case "window.minimize":
				window?.minimize();
				break;
			case "window.maximize":
				if (window?.isMaximized()) window.unmaximize();
				else window?.maximize();
				break;
			case "window.setCloseToTray":
				if (value.closeToTray === undefined) throw new Error("closeToTray is required");
				closeToTray = value.closeToTray;
				break;
			case "window.close":
				respond(true);
				quitting = true;
				app.quit();
				return;
			case "tray.destroy":
				tray?.destroy();
				tray = null;
				break;
			case "shortcut.register":
				registerShortcut(value);
				break;
			case "shortcut.unregister":
				unregisterShortcut(value);
				break;
		}
		respond(true);
		publishWindowState();
	} catch (error: unknown) {
		respond(false, currentWindowState(), error instanceof Error ? error.message : String(error));
	}
}

function registerShortcut(request: ElectronShellRequest): void {
	if (!request.shortcut) throw new Error("shortcut is required");
	if (registeredShortcut && registeredShortcut !== request.shortcut) globalShortcut.unregister(registeredShortcut);
	if (
		!globalShortcut.register(request.shortcut, () => {
			sendToHost({
				type: "pi-desktop.shell.event",
				token: hostToken,
				event: "shortcut.trigger",
				shortcut: request.shortcut ?? "",
			});
		})
	)
		throw new Error(`Shortcut is already registered: ${request.shortcut}`);
	registeredShortcut = request.shortcut;
}

function unregisterShortcut(request: ElectronShellRequest): void {
	if (!request.shortcut) throw new Error("shortcut is required");
	globalShortcut.unregister(request.shortcut);
	if (registeredShortcut === request.shortcut) registeredShortcut = undefined;
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
		if (closeToTray) window?.hide();
		else requestQuit();
	});
	window.on("show", publishWindowState);
	window.on("hide", publishWindowState);
	window.on("minimize", publishWindowState);
	window.on("maximize", publishWindowState);
	window.on("unmaximize", publishWindowState);
	window.on("restore", publishWindowState);
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
			{ label: "Open", click: () => handleTrayAction("open") },
			{ label: "Settings", click: () => handleTrayAction("settings") },
			{ type: "separator" },
			{ label: "Quit", click: () => handleTrayAction("quit") },
		]),
	);
	tray.on("double-click", () => handleTrayAction("open"));
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
		startHost();
		await showWindow();
	});
}
