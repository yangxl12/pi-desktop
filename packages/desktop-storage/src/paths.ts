import { homedir } from "node:os";
import { join } from "node:path";
import type { Platform } from "@earendil-works/pi-desktop-protocol";

export function desktopDataDirectory(platform: Platform, env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_DESKTOP_DATA_DIR) return env.PI_DESKTOP_DATA_DIR;
	if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Pi Desktop");
	if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Pi Desktop");
	return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pi-desktop");
}

export function projectSessionDirectory(dataDirectory: string, projectId: string): string {
	return join(dataDirectory, "sessions", projectId);
}
