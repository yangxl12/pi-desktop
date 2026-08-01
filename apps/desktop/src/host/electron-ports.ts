import { randomUUID } from "node:crypto";
import type { ShortcutPort, TrayPort, WindowPort } from "@earendil-works/pi-desktop-core";
import type { WindowState } from "@earendil-works/pi-desktop-protocol";
import {
	type ElectronShellEvent,
	type ElectronShellOperation,
	type ElectronShellRequest,
	isElectronShellEvent,
	isElectronShellResponse,
} from "../shared/electron-shell-ipc.ts";

const INITIAL_WINDOW_STATE: WindowState = { visible: true, minimized: false, maximized: false, closeToTray: true };

export interface ElectronShellTransport {
	send(message: ElectronShellRequest): void;
	onMessage(listener: (message: unknown) => void): () => void;
}

interface PendingRequest {
	resolve(state: WindowState | undefined): void;
	reject(error: Error): void;
	timeout: NodeJS.Timeout;
}

export class ElectronShellBridge {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(event: ElectronShellEvent) => void>();
	private readonly removeMessageListener: () => void;
	private readonly token: string;
	private readonly transport: ElectronShellTransport;

	constructor(token: string, transport: ElectronShellTransport) {
		this.token = token;
		this.transport = transport;
		this.removeMessageListener = transport.onMessage((message) => this.handleMessage(message));
	}

	request(
		operation: ElectronShellOperation,
		options: Pick<ElectronShellRequest, "shortcut" | "closeToTray"> = {},
	): Promise<WindowState | undefined> {
		const id = randomUUID();
		return new Promise<WindowState | undefined>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Electron shell request timed out: ${operation}`));
			}, 5_000);
			this.pending.set(id, { resolve, reject, timeout });
			try {
				this.transport.send({ type: "pi-desktop.shell.request", id, token: this.token, operation, ...options });
			} catch (error: unknown) {
				clearTimeout(timeout);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	subscribe(listener: (event: ElectronShellEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.removeMessageListener();
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error("Electron shell connection closed"));
		}
		this.pending.clear();
	}

	private handleMessage(value: unknown): void {
		if (isElectronShellResponse(value) && value.token === this.token) {
			const pending = this.pending.get(value.id);
			if (!pending) return;
			clearTimeout(pending.timeout);
			this.pending.delete(value.id);
			if (value.success) pending.resolve(value.state);
			else pending.reject(new Error(value.error ?? "Electron shell request failed"));
			return;
		}
		if (isElectronShellEvent(value) && value.token === this.token) {
			for (const listener of this.listeners) listener(value);
		}
	}
}

export class ElectronWindowPort implements WindowPort {
	private state: WindowState = { ...INITIAL_WINDOW_STATE };
	private readonly listeners = new Set<(state: WindowState) => void>();
	private readonly bridge: ElectronShellBridge;

	constructor(bridge: ElectronShellBridge) {
		this.bridge = bridge;
		bridge.subscribe((event) => {
			if (event.event === "window.changed") this.setState(event.state);
		});
	}

	async refresh(): Promise<void> {
		await this.run("window.getState");
	}

	show(): Promise<void> {
		return this.run("window.show");
	}

	hide(): Promise<void> {
		return this.run("window.hide");
	}

	toggle(): Promise<void> {
		return this.run("window.toggle");
	}

	minimize(): Promise<void> {
		return this.run("window.minimize");
	}

	maximize(): Promise<void> {
		return this.run("window.maximize");
	}

	setCloseToTray(closeToTray: boolean): Promise<void> {
		return this.run("window.setCloseToTray", { closeToTray });
	}

	close(): Promise<void> {
		return this.run("window.close");
	}

	getState(): WindowState {
		return { ...this.state };
	}

	onChanged(listener: (state: WindowState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async run(
		operation: ElectronShellOperation,
		options: Pick<ElectronShellRequest, "shortcut" | "closeToTray"> = {},
	): Promise<void> {
		const state = await this.bridge.request(operation, options);
		if (state) this.setState(state);
	}

	private setState(state: WindowState): void {
		this.state = { ...state };
		for (const listener of this.listeners) listener(this.getState());
	}
}

export class ElectronTrayPort implements TrayPort {
	private actions: { open(): void; settings(): void; quit(): void } | undefined;
	private readonly bridge: ElectronShellBridge;

	constructor(bridge: ElectronShellBridge) {
		this.bridge = bridge;
		bridge.subscribe((event) => {
			if (event.event === "tray.action") this.actions?.[event.action]();
		});
	}

	create(actions: { open(): void; settings(): void; quit(): void }): void {
		this.actions = actions;
	}

	async destroy(): Promise<void> {
		this.actions = undefined;
		await this.bridge.request("tray.destroy");
	}
}

export class ElectronShortcutPort implements ShortcutPort {
	private readonly callbacks = new Map<string, () => void>();
	private readonly bridge: ElectronShellBridge;

	constructor(bridge: ElectronShellBridge) {
		this.bridge = bridge;
		bridge.subscribe((event) => {
			if (event.event === "shortcut.trigger") this.callbacks.get(event.shortcut)?.();
		});
	}

	async register(shortcut: string, callback: () => void): Promise<void> {
		await this.bridge.request("shortcut.register", { shortcut });
		this.callbacks.set(shortcut, callback);
	}

	async unregister(shortcut: string): Promise<void> {
		await this.bridge.request("shortcut.unregister", { shortcut });
		this.callbacks.delete(shortcut);
	}
}

export class ElectronDesktopPorts {
	readonly window: ElectronWindowPort;
	readonly tray: ElectronTrayPort;
	readonly shortcut: ElectronShortcutPort;
	private readonly bridge: ElectronShellBridge;

	constructor(bridge: ElectronShellBridge) {
		this.bridge = bridge;
		this.window = new ElectronWindowPort(bridge);
		this.tray = new ElectronTrayPort(bridge);
		this.shortcut = new ElectronShortcutPort(bridge);
	}

	refresh(): Promise<void> {
		return this.window.refresh();
	}

	dispose(): void {
		this.bridge.dispose();
	}
}

export function createElectronDesktopPorts(): ElectronDesktopPorts | undefined {
	const token = process.env.PI_DESKTOP_HOST_TOKEN;
	if (!token || !process.send) return undefined;
	const transport: ElectronShellTransport = {
		send(message) {
			if (!process.send?.(message)) throw new Error("Electron shell IPC channel is unavailable");
		},
		onMessage(listener) {
			const onMessage = (message: unknown) => listener(message);
			process.on("message", onMessage);
			return () => process.off("message", onMessage);
		},
	};
	return new ElectronDesktopPorts(new ElectronShellBridge(token, transport));
}
