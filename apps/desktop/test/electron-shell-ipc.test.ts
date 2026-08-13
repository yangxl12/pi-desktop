import { describe, expect, it } from "vitest";
import {
	isElectronHostFatalMessage,
	isElectronShellRequest,
	isElectronShellResponse,
} from "../src/shared/electron-shell-ipc.ts";

describe("isElectronHostFatalMessage", () => {
	it("accepts a valid host fatal message", () => {
		expect(
			isElectronHostFatalMessage({
				type: "pi-desktop.host.fatal",
				token: "token",
				reason: "Pi Desktop is already running",
			}),
		).toBe(true);
	});

	it("rejects messages with a mismatched type, token or reason", () => {
		expect(
			isElectronHostFatalMessage({
				type: "pi-desktop.shell.request",
				token: "token",
				reason: "Pi Desktop is already running",
			}),
		).toBe(false);
		expect(
			isElectronHostFatalMessage({
				type: "pi-desktop.host.fatal",
				reason: "Pi Desktop is already running",
			}),
		).toBe(false);
		expect(
			isElectronHostFatalMessage({
				type: "pi-desktop.host.fatal",
				token: "token",
				reason: 42,
			}),
		).toBe(false);
		expect(isElectronHostFatalMessage(null)).toBe(false);
	});
});

describe("Electron folder picker IPC", () => {
	it("accepts folder picker requests and nullable path responses", () => {
		expect(
			isElectronShellRequest({
				type: "pi-desktop.shell.request",
				id: "request",
				token: "token",
				operation: "dialog.selectProjectFolder",
			}),
		).toBe(true);
		expect(
			isElectronShellResponse({
				type: "pi-desktop.shell.response",
				id: "request",
				token: "token",
				success: true,
				folderPath: null,
			}),
		).toBe(true);
		expect(
			isElectronShellResponse({
				type: "pi-desktop.shell.response",
				id: "request",
				token: "token",
				success: true,
				folderPath: 42,
			}),
		).toBe(false);
	});
});
