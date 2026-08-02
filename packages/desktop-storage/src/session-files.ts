import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
	SessionCodec,
	SessionFileRepository,
	SessionFileSummary,
	SessionScanResult,
} from "@earendil-works/pi-desktop-core";
import type { DesktopMessage, MessagePart, ThinkingLevel } from "@earendil-works/pi-desktop-protocol";
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

function timestamp(value: unknown): string {
	if (typeof value === "number") return new Date(value).toISOString();
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
	}
	return new Date().toISOString();
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

export class PiSessionCodec implements SessionCodec {
	readonly id = "pi-jsonl";
	readonly formatVersion = 3;
	private readonly cache = new Map<string, { size: number; mtimeMs: number; summary: SessionFileSummary }>();

	canRead(sessionPath: string): Promise<boolean> {
		return this.exists(sessionPath);
	}

	async identify(sessionPath: string): Promise<{ codecId: string; formatVersion: number } | null> {
		try {
			const summary = await this.readSummary(sessionPath);
			return {
				codecId: summary.sessionCodecId ?? this.id,
				formatVersion: summary.sessionFormatVersion ?? this.formatVersion,
			};
		} catch {
			return null;
		}
	}

	async exists(sessionPath: string): Promise<boolean> {
		try {
			await access(sessionPath);
			return true;
		} catch {
			return false;
		}
	}

	async readSummary(sessionPath: string): Promise<SessionFileSummary> {
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
		let hasMessages = false;
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
			hasMessages = true;
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
		const summary: SessionFileSummary = {
			id: asString(header.id) ?? basename(sessionPath, ".jsonl"),
			sessionPath,
			title: title ?? firstUserText?.slice(0, 72) ?? "New conversation",
			createdAt: asString(header.timestamp) ?? fileStats.birthtime.toISOString(),
			updatedAt,
			modelProvider,
			modelId,
			thinkingLevel: level,
			leafId,
			hasMessages,
			runtimeProviderId: "pi",
			runtimeSessionRef: sessionPath,
			sessionCodecId: this.id,
			sessionFormatVersion: typeof header.version === "number" ? header.version : this.formatVersion,
			historyAccess: "continue",
		};
		this.cache.set(sessionPath, { size: fileStats.size, mtimeMs: fileStats.mtimeMs, summary });
		return summary;
	}

	/** Compatibility name retained for the pre-codec SessionFileRepository contract. */
	read(sessionPath: string): Promise<SessionFileSummary> {
		return this.readSummary(sessionPath);
	}

	async readMessages(sessionPath: string): Promise<DesktopMessage[]> {
		let content: string;
		try {
			content = await readFile(sessionPath, "utf8");
		} catch (_error: unknown) {
			throw new DesktopError("NOT_FOUND", "Session file is missing", { sessionPath });
		}
		const messages: DesktopMessage[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let entry: JsonRecord;
			try {
				const parsed = asRecord(JSON.parse(line));
				if (!parsed) continue;
				entry = parsed;
			} catch {
				throw new DesktopError("PROTOCOL_ERROR", "Session file contains invalid JSONL", { sessionPath });
			}
			if (entry.type !== "message") continue;
			const message = asRecord(entry.message);
			if (!message) continue;
			const role =
				message.role === "user" || message.role === "assistant" || message.role === "system"
					? message.role
					: "tool";
			const rawContent = message.content;
			const parts: MessagePart[] = [];
			if (Array.isArray(rawContent)) {
				for (const part of rawContent) {
					const value = asRecord(part);
					if (!value) continue;
					if (value.type === "thinking") parts.push({ type: "thinking", text: asString(value.thinking) ?? "" });
					else if (value.type === "toolCall")
						parts.push({
							type: "tool",
							text: JSON.stringify(value.arguments ?? ""),
							toolName: asString(value.name),
							toolCallId: asString(value.id),
							status: "started",
						});
					else parts.push({ type: "text", text: asString(value.text) ?? "" });
				}
			} else parts.push({ type: role === "tool" ? "tool" : "text", text: asString(rawContent) ?? "" });
			messages.push({
				id: asString(message.id) ?? `${role}-${messages.length}`,
				role,
				parts: parts.length ? parts : [{ type: "text", text: "" }],
				createdAt: timestamp(message.timestamp),
				status:
					message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "finished",
			});
		}
		return messages;
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
				const fileStats = await stat(sessionPath);
				const cached = this.cache.get(sessionPath);
				if (cached && cached.size === fileStats.size && cached.mtimeMs === fileStats.mtimeMs) {
					sessions.push(cached.summary);
				} else {
					sessions.push(await this.readSummary(sessionPath));
				}
			} catch (error: unknown) {
				diagnostics.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { sessions, diagnostics };
	}
}

/** Pre-codec name kept for existing callers and migration compatibility. */
export class PiSessionFileRepository extends PiSessionCodec implements SessionFileRepository {}
