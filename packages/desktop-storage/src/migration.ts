import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionScanResult } from "@earendil-works/pi-desktop-core";
import type { ConversationIndex, Project } from "@earendil-works/pi-desktop-protocol";

export interface SessionMigrationEntry {
	sessionId: string;
	sessionPath: string;
	runtimeProviderId: string;
	codecId: string;
	formatVersion: number | null;
	historyAccess: "continue" | "read-only" | "import-required" | "missing";
	status: "compatible" | "deprecated" | "missing" | "invalid";
	reason?: string;
}

export interface SessionMigrationReport {
	generatedAt: string;
	codec: { id: string; formatVersion: number };
	compatibilityWindow: { provider: string; supportedUntil: string; deprecation: string };
	projects: number;
	sessions: number;
	compatible: number;
	deprecated: number;
	missing: number;
	invalid: number;
	diagnostics: string[];
	entries: SessionMigrationEntry[];
}

/** Creates an auditable report without rewriting or deleting the Pi JSONL fact source. */
export function createSessionMigrationReport(
	projects: readonly Project[],
	conversations: readonly ConversationIndex[],
	scan: SessionScanResult,
	options: { codecId?: string; formatVersion?: number; supportedUntil?: string } = {},
): SessionMigrationReport {
	const codecId = options.codecId ?? "pi-jsonl";
	const formatVersion = options.formatVersion ?? 3;
	const byPath = new Map(scan.sessions.map((summary) => [summary.sessionPath, summary]));
	const entries: SessionMigrationEntry[] = [];
	for (const conversation of conversations) {
		const summary = byPath.get(conversation.sessionPath);
		if (!summary) {
			entries.push({
				sessionId: conversation.id,
				sessionPath: conversation.sessionPath,
				runtimeProviderId: conversation.runtimeProviderId ?? "pi",
				codecId: conversation.sessionCodecId ?? codecId,
				formatVersion: conversation.sessionFormatVersion ?? null,
				historyAccess: "missing",
				status: "missing",
				reason: "Session is indexed but the source file was not found",
			});
			continue;
		}
		const version = summary.sessionFormatVersion ?? formatVersion;
		const compatible =
			summary.runtimeProviderId === "pi" && summary.sessionCodecId === codecId && version <= formatVersion;
		entries.push({
			sessionId: conversation.id,
			sessionPath: conversation.sessionPath,
			runtimeProviderId: summary.runtimeProviderId ?? "pi",
			codecId: summary.sessionCodecId ?? codecId,
			formatVersion: version,
			historyAccess: summary.historyAccess ?? "continue",
			status: compatible ? "compatible" : "deprecated",
			reason: compatible ? undefined : "Session format/provider is outside the current continue window",
		});
	}
	for (const summary of scan.sessions) {
		if (entries.some((entry) => entry.sessionPath === summary.sessionPath)) continue;
		entries.push({
			sessionId: summary.id,
			sessionPath: summary.sessionPath,
			runtimeProviderId: summary.runtimeProviderId ?? "pi",
			codecId: summary.sessionCodecId ?? codecId,
			formatVersion: summary.sessionFormatVersion ?? null,
			historyAccess: summary.historyAccess ?? "continue",
			status: summary.hasMessages ? "compatible" : "invalid",
			reason: summary.hasMessages ? undefined : "Empty draft is not a migratable history entry",
		});
	}
	const count = (status: SessionMigrationEntry["status"]) => entries.filter((entry) => entry.status === status).length;
	return {
		generatedAt: new Date().toISOString(),
		codec: { id: codecId, formatVersion },
		compatibilityWindow: {
			provider: "pi",
			supportedUntil: options.supportedUntil ?? "2026-12-31",
			deprecation: "Pi JSONL remains read-only/importable after this window; originals are never overwritten.",
		},
		projects: projects.length,
		sessions: entries.length,
		compatible: count("compatible"),
		deprecated: count("deprecated"),
		missing: count("missing"),
		invalid: count("invalid"),
		diagnostics: [...scan.diagnostics],
		entries,
	};
}

export async function writeSessionMigrationReport(path: string, report: SessionMigrationReport): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
