export type Platform = "win32" | "darwin" | "linux";

export type TrustState = "unknown" | "trusted" | "untrusted";

export type ConversationStatus = "idle" | "streaming" | "error" | "aborted";

export type QueueMode = "prompt" | "steer" | "followUp";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type McpTransport = "stdio" | "http";

export type McpStatus = "stopped" | "starting" | "ready" | "error";

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

export type DesktopErrorCode =
	| "INVALID_ARGUMENT"
	| "NOT_FOUND"
	| "CONFLICT"
	| "NOT_READY"
	| "NOT_SUPPORTED"
	| "PERMISSION_DENIED"
	| "PROCESS_ERROR"
	| "PROTOCOL_ERROR"
	| "TIMEOUT"
	| "INTERNAL_ERROR";

export interface Project {
	id: string;
	name: string;
	rootPath: string;
	trustState: TrustState;
	createdAt: string;
	updatedAt: string;
	lastOpenedAt: string | null;
}

export interface ConversationIndex {
	id: string;
	projectId: string;
	sessionPath: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	modelProvider: string | null;
	modelId: string | null;
	thinkingLevel: ThinkingLevel;
	leafId: string | null;
	status: ConversationStatus;
}

export interface MessagePart {
	type: "text" | "thinking" | "tool" | "error";
	text: string;
	toolName?: string;
	toolCallId?: string;
	status?: "started" | "updated" | "finished" | "failed";
}

export interface DesktopMessage {
	id: string;
	role: "user" | "assistant" | "tool" | "system";
	parts: MessagePart[];
	createdAt: string;
	status?: "streaming" | "finished" | "aborted" | "error";
}

export interface ModelProfile {
	id: string;
	providerId: string;
	displayName: string;
	baseUrl: string;
	modelId: string;
	credentialRef: string | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ModelProfileDraft = Omit<ModelProfile, "id" | "credentialRef" | "createdAt" | "updatedAt">;

export type ModelProfilePatch = Partial<ModelProfileDraft>;

export interface ModelConnectionResult {
	ok: boolean;
	status: number | null;
	latencyMs: number;
	message: string;
}

export interface SkillCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill" | string;
	path?: string;
	scope?: "user" | "project" | "temporary";
}

export interface AppSettings {
	globalSystemPrompt: string;
	invokeShortcut: string;
	defaultModelProfileId: string | null;
	closeToTray: boolean;
	skillDirectories: string[];
	schemaVersion: number;
}

export interface RuntimeIdentity {
	projectId: string;
	sessionId: string;
	runtimeId: string;
}

export interface RuntimeSnapshot extends RuntimeIdentity {
	status: "starting" | "ready" | "streaming" | "stopped" | "error";
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	modelProvider: string | null;
	modelId: string | null;
	sessionPath: string | null;
	messageCount: number;
	lastError: string | null;
}

export interface Diagnostic {
	level: "info" | "warning" | "error";
	component: string;
	message: string;
	projectId?: string;
	sessionId?: string;
	runtimeId?: string;
	requestId?: string;
	createdAt: string;
}

export interface DesktopErrorShape {
	code: DesktopErrorCode;
	message: string;
	details?: Record<string, unknown>;
}

export interface WindowState {
	visible: boolean;
	minimized: boolean;
	maximized: boolean;
	closeToTray: boolean;
}

export interface DesktopState {
	platform: Platform;
	window: WindowState;
	projects: Project[];
	activeProjectId: string | null;
	conversations: ConversationIndex[];
	activeSessionId: string | null;
	runtime: RuntimeSnapshot | null;
	messages: DesktopMessage[];
	models: ModelProfile[];
	commands: SkillCommand[];
	mcpServers: McpServerSnapshot[];
	mcpTools: McpTool[];
	settings: AppSettings;
	diagnostics: Diagnostic[];
}
