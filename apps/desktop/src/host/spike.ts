import { platform, release } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultInvokeShortcut } from "@earendil-works/pi-desktop-core";
import type { Platform } from "@earendil-works/pi-desktop-protocol";

interface SpikeReport {
	platform: NodeJS.Platform;
	osRelease: string;
	node: string;
	rpcEntry: string;
	defaultShortcut: string;
	sessionDirectoryExample: string;
	secretStore: "host-port-required";
	windowShell: "host-port-required";
	mcp: "stdio-and-streamable-http-with-policy";
}

const desktopPlatform: Platform = platform() === "win32" ? "win32" : platform() === "darwin" ? "darwin" : "linux";
const report: SpikeReport = {
	platform: process.platform,
	osRelease: release(),
	node: process.version,
	rpcEntry: fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry")),
	defaultShortcut: defaultInvokeShortcut(desktopPlatform),
	sessionDirectoryExample: `${process.env.PI_CONFIG_DIR ?? "~/.pi"}/agent/sessions/<encoded-cwd>`,
	secretStore: "host-port-required",
	windowShell: "host-port-required",
	mcp: "stdio-and-streamable-http-with-policy",
};

console.log(JSON.stringify(report, null, 2));
