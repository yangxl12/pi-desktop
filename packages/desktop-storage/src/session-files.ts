import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionFileRepository, SessionFileSummary, SessionScanResult } from "@earendil-works/pi-desktop-core";
import type { ThinkingLevel } from "@earendil-works/pi-desktop-protocol";
import { DesktopError } from "@earendil-works/pi-desktop-protocol";

interface JsonRecord {
	[key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function messageText(message: JsonRecord): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => asString(asRecord(part)?.text) ?? "")
		.join("")
		.trim();
}

function thinkingLevel(value: unknown): ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string)
		? (value as ThinkingLevel)
		: "off";
}

export class PiSessionFileRepository implements SessionFileRepository {
	async exists(sessionPath: string): Promise<boolean> {
		try {
			await access(sessionPath);
			return true;
		} catch {
			return false;
		}
	}

	async read(sessionPath: string): Promise<SessionFileSummary> {
		let content: string;
		try {
			content = await readFile(sessionPath, "utf8");
		} catch (error: unknown) {
			throw new DesktopError("NOT_FOUND", "Session file is missing", {
				sessionPath,
				cause: error instanceof Error ? error.message : String(error),
			});
		}
		const entries: JsonRecord[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = asRecord(JSON.parse(line));
				if (parsed) entries.push(parsed);
			} catch (error: unknown) {
				throw new DesktopError("PROTOCOL_ERROR", "Session file contains invalid JSONL", {
					sessionPath,
					cause: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const header = entries[0];
		if (header?.type !== "session" || !asString(header.id)) {
			throw new DesktopError("PROTOCOL_ERROR", "Session file header is invalid", { sessionPath });
		}
		let title: string | undefined;
		let firstUserText: string | undefined;
		let modelProvider: string | null = null;
		let modelId: string | null = null;
		let level: ThinkingLevel = "off";
		let leafId: string | null = null;
		let updatedAt = asString(header.timestamp) ?? new Date(0).toISOString();
		for (const entry of entries.slice(1)) {
			leafId = asString(entry.id) ?? leafId;
			updatedAt = asString(entry.timestamp) ?? updatedAt;
			if (entry.type === "session_info" && asString(entry.name)) title = asString(entry.name);
			if (entry.type === "thinking_level_change") level = thinkingLevel(entry.thinkingLevel);
			if (entry.type === "model_change") {
				modelProvider = asString(entry.provider) ?? modelProvider;
				modelId = asString(entry.modelId) ?? modelId;
			}
			if (entry.type !== "message") continue;
			const message = asRecord(entry.message);
			if (!message) continue;
			if (message.role === "user" && !firstUserText) firstUserText = messageText(message);
			if (message.role === "assistant") {
				modelProvider = asString(message.provider) ?? modelProvider;
				modelId = asString(message.model) ?? modelId;
			}
		}
		const fileStats = await stat(sessionPath);
		if (updatedAt === new Date(0).toISOString()) updatedAt = fileStats.mtime.toISOString();
		return {
			id: asString(header.id) ?? basename(sessionPath, ".jsonl"),
			sessionPath,
			title: title ?? firstUserText?.slice(0, 72) ?? "New conversation",
			createdAt: asString(header.timestamp) ?? fileStats.birthtime.toISOString(),
			updatedAt,
			modelProvider,
			modelId,
			thinkingLevel: level,
			leafId,
		};
	}

	async scan(sessionDirectory: string): Promise<SessionScanResult> {
		let files: string[];
		try {
			files = (await readdir(sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [], diagnostics: [] };
			throw error;
		}
		const sessions: SessionFileSummary[] = [];
		const diagnostics: string[] = [];
		for (const file of files) {
			const sessionPath = join(sessionDirectory, file);
			try {
				sessions.push(await this.read(sessionPath));
			} catch (error: unknown) {
				diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { sessions, diagnostics };
	}
}
