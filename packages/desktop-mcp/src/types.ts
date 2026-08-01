export type McpTransport = "stdio" | "http";

export interface McpServerProfile {
	id: string;
	name: string;
	transport: McpTransport;
	command: string | null;
	args: string[];
	env: Record<string, string>;
	url: string | null;
	credentialRef: string | null;
	namespace: string;
	enabled: boolean;
	timeoutMs: number;
	maxOutputBytes: number;
	projectId: string | null;
}

export type McpServerDraft = Omit<McpServerProfile, "id">;
export type McpServerPatch = Partial<McpServerDraft>;

export type McpStatus = "stopped" | "starting" | "ready" | "error";

export interface McpServerSnapshot {
	profile: McpServerProfile;
	status: McpStatus;
	toolCount: number;
	lastError: string | null;
	startedAt: string | null;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	serverId: string;
	namespacedName: string;
}

export interface McpToolResult {
	content: Array<Record<string, unknown>>;
	isError?: boolean;
}

export interface McpConsentRequest {
	serverId: string;
	toolName: string;
	projectId: string | null;
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
	| (McpEventBase & { type: "tool.finished"; toolName: string; requestId: string; failed: boolean });

export type McpEventListener = (event: McpEvent) => void;
