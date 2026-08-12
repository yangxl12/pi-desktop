import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { previewFileContentType } from "./static-content.ts";

/** Upper bound for files served through the preview endpoint. */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

export interface PreviewProjectState {
	id: string;
	rootPath: string;
}

/** Extract the known projects from the raw desktop state the gateway exposes. */
export function projectsFromState(state: unknown): PreviewProjectState[] {
	const record = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : null;
	const projects = record?.projects;
	if (!Array.isArray(projects)) return [];
	return projects.flatMap((candidate) => {
		const project =
			typeof candidate === "object" && candidate !== null ? (candidate as Record<string, unknown>) : null;
		const id = typeof project?.id === "string" ? project.id : null;
		const rootPath = typeof project?.rootPath === "string" ? project.rootPath : null;
		return id && rootPath ? [{ id, rootPath }] : [];
	});
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
	if (response.headersSent) return;
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}

function deny(
	response: ServerResponse,
	statusCode: number,
	code: string,
	message: string,
	details?: Record<string, unknown>,
): void {
	sendJson(response, statusCode, { success: false, error: { code, message, details } });
}

/**
 * Serve a project file for the preview panel. The path is validated against
 * the project root (no traversal, no absolute paths) and capped in size.
 */
export async function serveProjectFile(
	projects: readonly PreviewProjectState[],
	projectId: string,
	requestedPath: string,
	response: ServerResponse,
): Promise<void> {
	if (!projectId) return deny(response, 400, "INVALID_ARGUMENT", "projectId is required");
	if (!requestedPath) return deny(response, 400, "INVALID_ARGUMENT", "path is required");
	if (requestedPath.includes("\0")) return deny(response, 400, "INVALID_ARGUMENT", "path is invalid");
	const project = projects.find((candidate) => candidate.id === projectId);
	if (!project) return deny(response, 404, "NOT_FOUND", "Project not found");
	if (isAbsolute(requestedPath))
		return deny(response, 400, "INVALID_ARGUMENT", "path must be relative to the project root");
	const rootPath = normalize(project.rootPath);
	const filePath = normalize(join(rootPath, requestedPath));
	if (relative(rootPath, filePath).startsWith(`..${sep}`) || relative(rootPath, filePath) === "..") {
		deny(response, 403, "PERMISSION_DENIED", "Path escapes the project root");
		return;
	}
	try {
		const info = await stat(filePath);
		if (!info.isFile()) return deny(response, 404, "NOT_FOUND", "File not found");
		if (info.size > PREVIEW_MAX_BYTES) {
			deny(response, 413, "INVALID_ARGUMENT", "File is too large to preview", { maxBytes: PREVIEW_MAX_BYTES });
			return;
		}
		const content = await readFile(filePath);
		response.writeHead(200, {
			"content-type": previewFileContentType(filePath),
			"content-length": content.byteLength,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		response.end(content);
	} catch {
		deny(response, 404, "NOT_FOUND", "File not found");
	}
}
