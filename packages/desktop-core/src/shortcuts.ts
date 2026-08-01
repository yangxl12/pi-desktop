import type { Platform } from "@earendil-works/pi-desktop-protocol";
import { DesktopError } from "@earendil-works/pi-desktop-protocol";

export const DEFAULT_INVOKE_SHORTCUTS: Readonly<Record<Platform, string>> = {
	win32: "Ctrl+Shift+0",
	darwin: "Cmd+Shift+0",
	linux: "Ctrl+Shift+0",
};

const MODIFIERS = new Set(["CTRL", "CMD", "ALT", "SHIFT", "META"]);

export function normalizeShortcut(value: string, platform: Platform): string {
	const pieces = value
		.split("+")
		.map((part) => part.trim().toUpperCase())
		.filter((part) => part.length > 0);
	if (pieces.length < 2 || !pieces.some((piece) => MODIFIERS.has(piece))) {
		throw new DesktopError("INVALID_ARGUMENT", "A shortcut must contain a modifier and a key");
	}
	const key = pieces[pieces.length - 1];
	if (MODIFIERS.has(key) || !/^[A-Z0-9]+$/.test(key)) {
		throw new DesktopError("INVALID_ARGUMENT", "Shortcut key is invalid");
	}
	const modifiers = [...new Set(pieces.slice(0, -1))];
	if (modifiers.some((modifier) => !MODIFIERS.has(modifier))) {
		throw new DesktopError("INVALID_ARGUMENT", "Shortcut modifier is invalid");
	}
	const platformPrimary = platform === "darwin" ? "CMD" : "CTRL";
	const ordered = [
		...new Set([platformPrimary, "CTRL", "ALT", "SHIFT", "META"].filter((modifier) => modifiers.includes(modifier))),
	];
	if (platform === "darwin" && ordered.includes("CTRL") && !ordered.includes("CMD")) {
		return [...ordered, key].map((part) => part[0] + part.slice(1).toLowerCase()).join("+");
	}
	return [...ordered, key].map((part) => part[0] + part.slice(1).toLowerCase()).join("+");
}

export function defaultInvokeShortcut(platform: Platform): string {
	return DEFAULT_INVOKE_SHORTCUTS[platform];
}
