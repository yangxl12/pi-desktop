import { statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DesktopError } from "@earendil-works/pi-desktop-protocol";

export async function canonicalizeProjectPath(rootPath: string): Promise<string> {
	if (!rootPath.trim()) throw new DesktopError("INVALID_ARGUMENT", "Project path cannot be empty");
	let canonicalPath: string;
	try {
		canonicalPath = await realpath(resolve(rootPath));
	} catch (error: unknown) {
		throw new DesktopError("NOT_FOUND", "Project directory does not exist", {
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	try {
		if (!statSync(canonicalPath).isDirectory()) throw new Error("not a directory");
	} catch {
		throw new DesktopError("INVALID_ARGUMENT", "Project path must be a directory");
	}
	return canonicalPath;
}

export async function canonicalizeResourcePath(resourcePath: string): Promise<string> {
	if (!resourcePath.trim()) throw new DesktopError("INVALID_ARGUMENT", "Resource path cannot be empty");
	try {
		return await realpath(resolve(resourcePath));
	} catch (error: unknown) {
		throw new DesktopError("NOT_FOUND", "Resource path does not exist", {
			cause: error instanceof Error ? error.message : String(error),
		});
	}
}

export function projectName(rootPath: string): string {
	return basename(rootPath) || rootPath;
}
