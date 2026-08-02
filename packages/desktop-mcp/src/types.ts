import type { McpConsentRequest, McpServerSnapshot, McpTool } from "@earendil-works/pi-desktop-protocol";

export type {
	McpConsentRequest,
	McpServerDraft,
	McpServerPatch,
	McpServerProfile,
	McpServerSnapshot,
	McpStatus,
	McpTool,
	McpTransport,
} from "@earendil-works/pi-desktop-protocol";

export interface McpToolResult {
	content: Array<Record<string, unknown>>;
	isError?: boolean;
}

export type McpConsent = (request: McpConsentRequest) => Promise<boolean>;

export interface McpSecretResolver {
	get(ref: string): Promise<string | null>;
}

export interface McpEventBase {
	serverId: string;
	createdAt: string;
}

export type McpEvent =
	| (McpEventBase & { type: "server.started"; snapshot: McpServerSnapshot })
	| (McpEventBase & { type: "server.stopped"; reason?: string })
	| (McpEventBase & { type: "server.error"; error: string })
	| (McpEventBase & { type: "tools.changed"; tools: McpTool[] })
	| (McpEventBase & { type: "tool.started"; toolName: string; requestId: string })
	| (McpEventBase & { type: "tool.finished"; toolName: string; requestId: string; failed: boolean })
	| (McpEventBase & { type: "consent.required"; request: McpConsentRequest })
	| (McpEventBase & { type: "consent.resolved"; requestId: string; approved: boolean });

export type McpEventListener = (event: McpEvent) => void;
