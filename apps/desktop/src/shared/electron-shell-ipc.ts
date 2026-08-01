import type { WindowState } from "@earendil-works/pi-desktop-protocol";

export type ElectronShellOperation =
	| "window.getState"
	| "window.show"
	| "window.hide"
	| "window.toggle"
	| "window.minimize"
	| "window.maximize"
	| "window.setCloseToTray"
	| "window.close"
	| "tray.destroy"
	| "shortcut.register"
	| "shortcut.unregister";

export interface ElectronShellRequest {
	type: "pi-desktop.shell.request";
	id: string;
	token: string;
	operation: ElectronShellOperation;
	shortcut?: string;
	closeToTray?: boolean;
}

export interface ElectronShellResponse {
	type: "pi-desktop.shell.response";
	id: string;
	token: string;
	success: boolean;
	state?: WindowState;
	error?: string;
}

export type ElectronShellEvent =
	| { type: "pi-desktop.shell.event"; token: string; event: "window.changed"; state: WindowState }
	| { type: "pi-desktop.shell.event"; token: string; event: "tray.action"; action: "open" | "settings" | "quit" }
	| { type: "pi-desktop.shell.event"; token: string; event: "shortcut.trigger"; shortcut: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOperation(value: unknown): value is ElectronShellOperation {
	return (
		value === "window.getState" ||
		value === "window.show" ||
		value === "window.hide" ||
		value === "window.toggle" ||
		value === "window.minimize" ||
		value === "window.maximize" ||
		value === "window.setCloseToTray" ||
		value === "window.close" ||
		value === "tray.destroy" ||
		value === "shortcut.register" ||
		value === "shortcut.unregister"
	);
}

export function isWindowState(value: unknown): value is WindowState {
	return (
		isRecord(value) &&
		typeof value.visible === "boolean" &&
		typeof value.minimized === "boolean" &&
		typeof value.maximized === "boolean" &&
		typeof value.closeToTray === "boolean"
	);
}

export function isElectronShellRequest(value: unknown): value is ElectronShellRequest {
	return (
		isRecord(value) &&
		value.type === "pi-desktop.shell.request" &&
		typeof value.id === "string" &&
		typeof value.token === "string" &&
		isOperation(value.operation) &&
		(value.shortcut === undefined || typeof value.shortcut === "string") &&
		(value.closeToTray === undefined || typeof value.closeToTray === "boolean")
	);
}

export function isElectronShellResponse(value: unknown): value is ElectronShellResponse {
	return (
		isRecord(value) &&
		value.type === "pi-desktop.shell.response" &&
		typeof value.id === "string" &&
		typeof value.token === "string" &&
		typeof value.success === "boolean" &&
		(value.state === undefined || isWindowState(value.state)) &&
		(value.error === undefined || typeof value.error === "string")
	);
}

export function isElectronShellEvent(value: unknown): value is ElectronShellEvent {
	if (!isRecord(value) || value.type !== "pi-desktop.shell.event" || typeof value.token !== "string") return false;
	if (value.event === "window.changed") return isWindowState(value.state);
	if (value.event === "tray.action")
		return value.action === "open" || value.action === "settings" || value.action === "quit";
	return value.event === "shortcut.trigger" && typeof value.shortcut === "string";
}
