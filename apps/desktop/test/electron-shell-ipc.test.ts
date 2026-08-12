import { describe, expect, it } from "vitest";
import { isElectronHostFatalMessage } from "../src/shared/electron-shell-ipc.ts";

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
