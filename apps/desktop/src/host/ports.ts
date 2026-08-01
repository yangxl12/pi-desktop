import type { ShortcutPort, SingleInstancePort, TrayPort, WindowPort } from "@earendil-works/pi-desktop-core";
import type { WindowState } from "@earendil-works/pi-desktop-protocol";

export class MemoryWindowPort implements WindowPort {
	private state: WindowState = { visible: true, minimized: false, maximized: false, closeToTray: true };
	private readonly listeners = new Set<(state: WindowState) => void>();

	show(): void {
		this.update({ visible: true, minimized: false });
	}
	hide(): void {
		this.update({ visible: false });
	}
	toggle(): void {
		this.state.visible ? this.hide() : this.show();
	}
	minimize(): void {
		this.update({ minimized: true, visible: true });
	}
	maximize(): void {
		this.update({ maximized: !this.state.maximized, visible: true });
	}
	close(): void {
		this.update({ visible: false });
	}
	getState(): WindowState {
		return { ...this.state };
	}
	onChanged(listener: (state: WindowState) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private update(patch: Partial<WindowState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener(this.getState());
	}
}

export class MemoryTrayPort implements TrayPort {
	private actions: { open(): void; settings(): void; quit(): void } | undefined;
	create(actions: { open(): void; settings(): void; quit(): void }): void {
		this.actions = actions;
	}
	destroy(): void {
		this.actions = undefined;
	}
	trigger(action: "open" | "settings" | "quit"): void {
		this.actions?.[action]();
	}
}

export class MemoryShortcutPort implements ShortcutPort {
	private readonly callbacks = new Map<string, () => void>();

	register(shortcut: string, callback: () => void): void {
		if (this.callbacks.has(shortcut)) throw new Error(`Shortcut already registered: ${shortcut}`);
		this.callbacks.set(shortcut, callback);
	}
	unregister(shortcut: string): void {
		this.callbacks.delete(shortcut);
	}
	trigger(shortcut: string): void {
		this.callbacks.get(shortcut)?.();
	}
	registered(): string[] {
		return [...this.callbacks.keys()];
	}
}

export class MemorySingleInstancePort implements SingleInstancePort {
	private static held = false;
	private heldByThisInstance = false;

	acquire(_onSecondInstance: () => void): boolean {
		if (MemorySingleInstancePort.held) return false;
		MemorySingleInstancePort.held = true;
		this.heldByThisInstance = true;
		return true;
	}
	release(): void {
		if (!this.heldByThisInstance) return;
		MemorySingleInstancePort.held = false;
		this.heldByThisInstance = false;
	}
}
