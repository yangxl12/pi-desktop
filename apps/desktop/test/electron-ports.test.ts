import { describe, expect, it } from "vitest";
import {
	ElectronShellBridge,
	ElectronShortcutPort,
	ElectronTrayPort,
	ElectronWindowPort,
	type ElectronShellTransport,
} from "../src/host/electron-ports.ts";
import type {
	ElectronShellEvent,
	ElectronShellRequest,
	ElectronShellResponse,
} from "../src/shared/electron-shell-ipc.ts";

class FakeTransport implements ElectronShellTransport {
	readonly requests: ElectronShellRequest[] = [];
	private listener: ((message: unknown) => void) | undefined;
	private state = { visible: true, minimized: false, maximized: false, closeToTray: true };

	send(request: ElectronShellRequest): void {
		this.requests.push(request);
		if (request.operation === "window.hide") this.state.visible = false;
		if (request.operation === "window.show") this.state.visible = true;
		if (request.operation === "window.setCloseToTray" && request.closeToTray !== undefined)
			this.state.closeToTray = request.closeToTray;
		const response: ElectronShellResponse = {
			type: "pi-desktop.shell.response",
			id: request.id,
			token: request.token,
			success: true,
			state: { ...this.state },
		};
		this.listener?.(response);
	}

	onMessage(listener: (message: unknown) => void): () => void {
		this.listener = listener;
		return () => {
			this.listener = undefined;
		};
	}

	emit(event: ElectronShellEvent): void {
		this.listener?.(event);
	}
}

describe("Electron desktop ports", () => {
	it("forwards real shell state and native events to the core ports", async () => {
		const transport = new FakeTransport();
		const bridge = new ElectronShellBridge("test-token", transport);
		const window = new ElectronWindowPort(bridge);
		const tray = new ElectronTrayPort(bridge);
		const shortcut = new ElectronShortcutPort(bridge);

		await window.refresh();
		await window.hide();
		await window.setCloseToTray(false);
		expect(window.getState()).toEqual({ visible: false, minimized: false, maximized: false, closeToTray: false });

		let settingsOpened = 0;
		tray.create({ open: () => undefined, settings: () => settingsOpened++, quit: () => undefined });
		transport.emit({ type: "pi-desktop.shell.event", token: "test-token", event: "tray.action", action: "settings" });
		expect(settingsOpened).toBe(1);

		let shortcutTriggered = 0;
		await shortcut.register("Ctrl+Shift+0", () => shortcutTriggered++);
		transport.emit({
			type: "pi-desktop.shell.event",
			token: "test-token",
			event: "shortcut.trigger",
			shortcut: "Ctrl+Shift+0",
		});
		expect(shortcutTriggered).toBe(1);
		expect(transport.requests.map((request) => request.operation)).toEqual([
			"window.getState",
			"window.hide",
			"window.setCloseToTray",
			"shortcut.register",
		]);
		bridge.dispose();
	});
});
