import type { Platform } from "@earendil-works/pi-desktop-protocol";
import { DesktopError } from "@earendil-works/pi-desktop-protocol";

export const DEFAULT_INVOKE_SHORTCUTS: Readonly<Record<Platform, string>> = {
	win32: "Alt+Shift+O",
	darwin: "Alt+Shift+O",
	linux: "Alt+Shift+O",
};

const MODIFIERS = new Set(["CTRL", "CMD", "ALT", "SHIFT", "META", "CMDORCTRL"]);
const KEY_ALIASES: Readonly<Record<string, string>> = {
	ESC: "Escape",
	ESCAPE: "Escape",
	SPACE: "Space",
	TAB: "Tab",
	ENTER: "Enter",
	RETURN: "Enter",
	BACKSPACE: "Backspace",
	DELETE: "Delete",
	INSERT: "Insert",
	HOME: "Home",
	END: "End",
	PAGEUP: "PageUp",
	PAGEDOWN: "PageDown",
	UP: "Up",
	DOWN: "Down",
	LEFT: "Left",
	RIGHT: "Right",
};

function normalizeKey(value: string): string | undefined {
	if (/^[A-Z0-9]$/.test(value)) return value;
	if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(value)) return value;
	return KEY_ALIASES[value];
}

export function normalizeShortcut(value: string, platform: Platform): string {
	const pieces = value
		.split("+")
		.map((part) => part.trim().toUpperCase())
		.filter((part) => part.length > 0);
	if (pieces.length < 2 || !pieces.some((piece) => MODIFIERS.has(piece))) {
		throw new DesktopError("INVALID_ARGUMENT", "A shortcut must contain a modifier and a key");
	}
	const key = normalizeKey(pieces[pieces.length - 1]);
	if (!key || MODIFIERS.has(key.toUpperCase())) {
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
