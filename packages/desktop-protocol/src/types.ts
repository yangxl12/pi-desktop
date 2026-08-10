export type Platform = "win32" | "darwin" | "linux";

export type TrustState = "unknown" | "trusted" | "untrusted";

export type ConversationStatus = "idle" | "streaming" | "error" | "aborted";

export type QueueMode = "prompt" | "steer" | "followUp";

/** Opaque handle owned by a runtime provider. Pi currently uses a file path. */
export type RuntimeSessionRef = string;

export interface RuntimeCapabilities {
	prompt: boolean;
	steer: boolean;
	followUp: boolean;
	abort: boolean;
	sessionCreate: boolean;
	sessionSwitch: boolean;
	messageRead: boolean;
	streaming: boolean;
	toolCalling: boolean;
	skills: boolean;
	commands: boolean;
	thinkingLevel: boolean;
	modelSwitch: boolean;
	modelStreaming: boolean;
	multimodal: boolean;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AppLocale = "zh-CN" | "en";

export type AppTheme = "light" | "dark";

export type WebSearchProvider = "disabled" | "brave" | "tavily";

export type McpTransport = "stdio" | "http";

export type McpStatus = "stopped" | "starting" | "ready" | "error";

export type McpLaunchKind = "http" | "managed-npm" | "executable";

export type McpAgentAvailability = "unknown" | "pending" | "available" | "unavailable";

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
	/** New launch model. Legacy profiles infer this from transport/command. */
	launchKind?: McpLaunchKind;
	packageSpec?: string | null;
	packageVersion?: string | null;
	bin?: string | null;
	secretEnvRefs?: Record<string, string>;
	secretHeaderRefs?: Record<string, string>;
	scope?: "global" | "project";
}

export type McpServerDraft = Omit<McpServerProfile, "id">;
export type McpServerPatch = Partial<McpServerDraft>;

export interface McpServerSnapshot {
	profile: McpServerProfile;
	status: McpStatus;
	toolCount: number;
	lastError: string | null;
	startedAt: string | null;
	connectedAt?: string | null;
	lastConnectedAt?: string | null;
	lastCallAt?: string | null;
	serverInfo?: { name?: string; version?: string } | null;
	protocolVersion?: string | null;
	capabilities?: Record<string, unknown>;
	agentAvailability?: McpAgentAvailability;
	agentToolGeneration?: number | null;
	reconnectAttempt?: number;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	serverId: string;
	namespacedName: string;
}

/** Runtime-neutral tool metadata exposed to the core and renderer. */
export interface ToolDescriptor {
	name: string;
	namespace?: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	source: "mcp" | "builtin" | "web-search" | string;
	projectScope?: string | null;
	trustRequirement?: "trusted-project" | "none";
	consentRequirement?: "always" | "untrusted-project" | "never";
}

export interface McpConsentRequest {
	requestId: string;
	serverId: string;
	toolName: string;
	projectId: string | null;
	/** A redacted summary only; raw tool arguments never enter public state. */
	argumentsSummary?: string;
}

export type DesktopErrorCode =
	| "INVALID_ARGUMENT"
	| "UNAUTHORIZED"
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
	/** Runtime-neutral metadata added during the provider/codec migration. */
	runtimeProviderId?: string;
	runtimeSessionRef?: RuntimeSessionRef | null;
	sessionCodecId?: string;
	sessionFormatVersion?: number | null;
	historyAccess?: "continue" | "read-only" | "import-required" | "missing";
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
	durationMs?: number;
	status?: "streaming" | "finished" | "aborted" | "error";
}

export interface ModelProfile {
	id: string;
	providerId: string;
	displayName: string;
	baseUrl: string;
	modelId: string;
	credentialRef: string | null;
	protocol?: ModelProtocol;
	capabilities?: ModelCapabilities;
	credentialStrategy?: ModelCredentialStrategy;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export type ModelProfileDraft = Omit<ModelProfile, "id" | "credentialRef" | "createdAt" | "updatedAt">;

export type ModelProfilePatch = Partial<ModelProfileDraft>;

export type ModelProtocol = "openai-compatible" | "anthropic" | "local" | "custom";

export type ModelCredentialStrategy = "none" | "api-key" | "oauth" | "os-secret";

export interface ModelCapabilities {
	contextWindow?: number;
	streaming: boolean;
	toolCalling: boolean;
	thinking: boolean;
	multimodal: boolean;
}

export interface ConversationPage {
	items: ConversationIndex[];
	nextCursor: string | null;
}

export interface MessagePage {
	items: DesktopMessage[];
	nextCursor: string | null;
}

export interface PerformanceSnapshot {
	count: number;
	lastMs: number | null;
	averageMs: number | null;
	p95Ms: number | null;
}

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

export interface DesktopApprovalRequest {
	requestId: string;
	operation: "skill.install" | "skill.remove" | "mcp.install" | "mcp.update" | "mcp.remove";
	title: string;
	summary: string;
	risks: string[];
	createdAt: string;
}

export type SkillSourceKind = "npm" | "git" | "url" | "local" | "external";
export type SkillInstallScope = "global" | "project";
export type SkillInstallationStatus = "installing" | "installed" | "loaded" | "warning" | "error";
export type SkillInstallPhase = "inspect" | "download" | "copy" | "install" | "validate" | "commit" | "load";

export interface SkillSource {
	kind: SkillSourceKind;
	spec: string;
	version?: string | null;
	ref?: string | null;
}

export interface SkillInstallationSnapshot {
	id: string;
	name: string | null;
	description: string | null;
	source: SkillSource;
	scope: SkillInstallScope;
	path: string | null;
	version: string | null;
	status: SkillInstallationStatus;
	commandName: string | null;
	diagnostics: string[];
	operationId: string | null;
	installedAt: string | null;
	updatedAt: string;
}

export interface SkillInstallProgress {
	operationId: string;
	phase: SkillInstallPhase;
	status: "running" | "completed" | "failed" | "cancelled";
	message?: string;
	installation?: SkillInstallationSnapshot;
}

export interface RuntimeToolSetSnapshot {
	desiredGeneration: number;
	appliedGeneration: number | null;
	toolNames: string[];
	lastError: string | null;
}

export interface AppSettings {
	globalSystemPrompt: string;
	invokeShortcut: string;
	defaultModelProfileId: string | null;
	defaultThinkingLevel: ThinkingLevel;
	conversationFontSize: number;
	sidebarFontSize: number;
	closeToTray: boolean;
	skillDirectories: string[];
	locale: AppLocale;
	theme: AppTheme;
	webSearch: {
		provider: WebSearchProvider;
		credentialRef: string | null;
	};
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
	runtimeSessionRef?: RuntimeSessionRef | null;
	providerId?: string | null;
	capabilities?: RuntimeCapabilities;
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
	skillInstallations: SkillInstallationSnapshot[];
	mcpServers: McpServerSnapshot[];
	mcpTools: McpTool[];
	consentRequests: McpConsentRequest[];
	approvalRequests: DesktopApprovalRequest[];
	runtimeTools?: RuntimeToolSetSnapshot;
	settings: AppSettings;
	diagnostics: Diagnostic[];
	performance?: Record<string, PerformanceSnapshot>;
}
