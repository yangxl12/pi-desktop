import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakePiAgentPort } from "../../desktop-pi-bridge/src/fake-port.ts";
import { DesktopApplication, MemoryMetadataRepository } from "../src/index.ts";
import type { DesktopHostPorts } from "../src/ports.ts";

class TestWindow {
	private state = { visible: true, minimized: false, maximized: false, closeToTray: true };
	show(): void {
		this.state.visible = true;
	}
	hide(): void {
		this.state.visible = false;
	}
	toggle(): void {
		this.state.visible = !this.state.visible;
	}
	minimize(): void {
		this.state.minimized = true;
	}
	maximize(): void {
		this.state.maximized = !this.state.maximized;
	}
	setCloseToTray(closeToTray: boolean): void {
		this.state.closeToTray = closeToTray;
	}
	close(): void {
		this.state.visible = false;
	}
	getState(): typeof this.state {
		return { ...this.state };
	}
	onChanged(): () => void {
		return () => undefined;
	}
}

class TestTray {
	create(): void {
		/* no-op */
	}
	destroy(): void {
		/* no-op */
	}
}

class TestShortcut {
	private readonly callbacks = new Map<string, () => void>();
	register(shortcut: string, callback: () => void): void {
		if (this.callbacks.has(shortcut)) throw new Error("conflict");
		this.callbacks.set(shortcut, callback);
	}
	unregister(shortcut: string): void {
		this.callbacks.delete(shortcut);
	}
	registered(): string[] {
		return [...this.callbacks.keys()];
	}
}

class TestSingleInstance {
	acquire(): boolean {
		return true;
	}
	release(): void {
		/* no-op */
	}
}

function ports(): DesktopHostPorts {
	return {
		window: new TestWindow(),
		tray: new TestTray(),
		shortcut: new TestShortcut(),
		singleInstance: new TestSingleInstance(),
	};
}

describe("desktop application", () => {
	it("creates a runtime and exposes fake Pi streaming events", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new FakePiAgentPort({ response: "ok" }),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		const events: string[] = [];
		app.subscribe((event) => events.push(event.type));
		const project = await app.dispatch({ type: "projects.add", rootPath: root });
		expect(project.success).toBe(true);
		await app.dispatch({ type: "agent.prompt", text: "hello" });
		expect(
			app.getState().messages.some((message) => message.role === "assistant" && message.parts[0]?.text === "ok"),
		).toBe(true);
		expect(events).toContain("runtime.ready");
		expect(events).toContain("message.delta");
	});

	it("rolls back a conflicting shortcut registration", async () => {
		const shortcut = new TestShortcut();
		const app = new DesktopApplication({
			platform: "win32",
			ports: { ...ports(), shortcut },
			pi: new FakePiAgentPort(),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		shortcut.register("Alt+X", () => undefined);
		const response = await app.dispatch({ type: "settings.update", patch: { invokeShortcut: "Alt+X" } });
		expect(response.success).toBe(false);
		expect(shortcut.registered()).toContain("Ctrl+Shift+0");
	});

	it("applies close-to-tray settings to the window port", async () => {
		const window = new TestWindow();
		const app = new DesktopApplication({
			platform: "win32",
			ports: { ...ports(), window },
			pi: new FakePiAgentPort(),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		expect(window.getState().closeToTray).toBe(true);
		const response = await app.dispatch({ type: "settings.update", patch: { closeToTray: false } });
		expect(response.success).toBe(true);
		expect(window.getState().closeToTray).toBe(false);
	});
});
