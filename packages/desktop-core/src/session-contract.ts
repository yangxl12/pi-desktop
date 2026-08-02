import type { ConversationIndex, DesktopMessage } from "@earendil-works/pi-desktop-protocol";
import type { SessionFileSummary, SessionScanResult } from "./ports.ts";

export type SessionHistoryAccess = "continue" | "read-only" | "import-required" | "missing";

/** Opaque session identity used by core services. Pi maps opaqueRef to a JSONL path. */
export interface SessionHandle {
	runtimeProviderId: string;
	backendId: string;
	codecId: string;
	opaqueRef: string;
}

export interface SessionPage {
	items: ConversationIndex[];
	nextCursor: string | null;
	diagnostics?: string[];
}

export interface SessionListOptions {
	projectId?: string;
	limit?: number;
	cursor?: string;
}

export interface SessionCodec {
	readonly id: string;
	readonly formatVersion: number;
	canRead(ref: string): Promise<boolean> | boolean;
	identify?(ref: string): Promise<{ codecId: string; formatVersion: number } | null>;
	readSummary(ref: string): Promise<SessionFileSummary>;
	readMessages(ref: string): Promise<DesktopMessage[]>;
	scan(directory: string): Promise<SessionScanResult>;
	import?(ref: string, target?: string): Promise<SessionHandle>;
}

export interface SessionStore {
	readonly codec: SessionCodec;
	readSummary(handle: SessionHandle | string): Promise<SessionFileSummary>;
	readMessages(handle: SessionHandle | string): Promise<DesktopMessage[]>;
	exists(handle: SessionHandle | string): Promise<boolean>;
	list(directory: string, options?: { projectId?: string; limit?: number; cursor?: string }): Promise<SessionPage>;
	rebuild(directory: string): Promise<SessionScanResult>;
}

export function sessionHandle(
	opaqueRef: string,
	options: Partial<Omit<SessionHandle, "opaqueRef">> = {},
): SessionHandle {
	return {
		runtimeProviderId: options.runtimeProviderId ?? "pi",
		backendId: options.backendId ?? "filesystem",
		codecId: options.codecId ?? "pi-jsonl",
		opaqueRef,
	};
}
