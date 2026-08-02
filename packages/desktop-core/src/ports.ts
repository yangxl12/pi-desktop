import type {
	AppSettings,
	ConversationIndex,
	DesktopEventListener,
	DesktopMessage,
	Diagnostic,
	McpConsentRequest,
	McpServerProfile,
	McpServerSnapshot,
	McpTool,
	ModelProfile,
	Project,
	QueueMode,
	RuntimeSnapshot,
	SkillCommand,
	ThinkingLevel,
	WindowState,
} from "@earendil-works/pi-desktop-protocol";

export type {
	AgentEvent,
	AgentEventPayload,
	AgentRuntimePort,
	RuntimeCapabilities,
	RuntimeCommand,
	RuntimeModel,
	RuntimeSessionRef,
	RuntimeStartOptions,
	RuntimeState,
	RuntimeToolDefinition,
} from "./runtime-contract.ts";

export interface McpPortEvent {
	type:
		| "server.started"
		| "server.stopped"
		| "server.error"
		| "tools.changed"
		| "tool.started"
		| "tool.finished"
		| string;
	serverId?: string;
	snapshot?: McpServerSnapshot;
	tools?: McpTool[];
	error?: string;
	requestId?: string;
	toolName?: string;
	failed?: boolean;
	request?: McpConsentRequest;
	approved?: boolean;
}

import type {
	AgentEvent,
	AgentEventPayload,
	AgentRuntimePort,
	RuntimeCommand,
	RuntimeModel,
	RuntimeStartOptions,
	RuntimeState,
	RuntimeToolDefinition,
} from "./runtime-contract.ts";

/** Compatibility aliases. New code should use the runtime-neutral names. */
export type PiRuntimeModel = RuntimeModel;
export type PiRuntimeOptions = RuntimeStartOptions;
export type PiCommandInfo = RuntimeCommand;
export type PiAgentEvent = AgentEvent;
export type PiAgentEventPayload = AgentEventPayload;
export interface PiAgentState extends RuntimeState {
	sessionPath: string | null;
}
export interface PiAgentPort extends AgentRuntimePort {
	start(options: PiRuntimeOptions): Promise<PiAgentState>;
	getState(): Promise<PiAgentState>;
	newSession(): Promise<PiAgentState>;
	switchSession(sessionPath: string): Promise<PiAgentState>;
}

export interface WindowPort {
	show(): Promise<void> | void;
	hide(): Promise<void> | void;
	toggle(): Promise<void> | void;
	minimize(): Promise<void> | void;
	maximize(): Promise<void> | void;
	setCloseToTray(closeToTray: boolean): Promise<void> | void;
	close(): Promise<void> | void;
	getState(): WindowState;
	onChanged(listener: (state: WindowState) => void): () => void;
}

export interface TrayPort {
	create(actions: { open(): void; settings(): void; quit(): void }): Promise<void> | void;
	destroy(): Promise<void> | void;
}

export interface ShortcutPort {
	register(shortcut: string, callback: () => void): Promise<void> | void;
	unregister(shortcut: string): Promise<void> | void;
}

export interface SingleInstancePort {
	acquire(onSecondInstance: () => void): Promise<boolean> | boolean;
	release(): Promise<void> | void;
}

export interface FolderPickerPort {
	selectProjectFolder(): Promise<string | null>;
}

export interface MetadataRepository {
	initialize(): Promise<void>;
	loadSettings(): Promise<AppSettings>;
	saveSettings(settings: AppSettings): Promise<void>;
	listProjects(): Promise<Project[]>;
	saveProject(project: Project): Promise<void>;
	deleteProject(projectId: string): Promise<void>;
	listConversations(projectId: string): Promise<ConversationIndex[]>;
	saveConversation(conversation: ConversationIndex): Promise<void>;
	deleteConversation(sessionId: string): Promise<void>;
	listModels(): Promise<ModelProfile[]>;
	saveModel(profile: ModelProfile): Promise<void>;
	deleteModel(profileId: string): Promise<void>;
	listMcpServers(): Promise<McpServerProfile[]>;
	saveMcpServer(profile: McpServerProfile): Promise<void>;
	deleteMcpServer(serverId: string): Promise<void>;
	close(): Promise<void>;
}

export interface McpPort {
	setProfiles(profiles: readonly McpServerProfile[]): void;
	list(): McpServerSnapshot[];
	start(profile: McpServerProfile): Promise<McpServerSnapshot>;
	stop(serverId: string, reason?: string): Promise<void>;
	stopAll(reason?: string): Promise<void>;
	test(profile: McpServerProfile): Promise<McpServerSnapshot>;
	listTools(projectId?: string): McpTool[];
	listToolDefinitions?(projectId?: string, trusted?: boolean): RuntimeToolDefinition[];
	respondConsent?(requestId: string, approved: boolean, scope?: "once" | "session" | "project"): boolean;
	dispose?(): void;
	subscribe(listener: (event: McpPortEvent) => void): () => void;
}

export interface SecretStore {
	set(value: string, ref?: string): Promise<string>;
	get(ref: string): Promise<string | null>;
	delete(ref: string): Promise<void>;
}

export interface SessionFileSummary {
	id: string;
	sessionPath: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	modelProvider: string | null;
	modelId: string | null;
	thinkingLevel: ThinkingLevel;
	leafId: string | null;
	hasMessages: boolean;
	runtimeProviderId?: string;
	runtimeSessionRef?: string | null;
	sessionCodecId?: string;
	sessionFormatVersion?: number | null;
	historyAccess?: "continue" | "read-only" | "import-required" | "missing";
}

export interface SessionScanResult {
	sessions: SessionFileSummary[];
	diagnostics: string[];
}

export interface SessionFileRepository {
	exists(sessionPath: string): Promise<boolean>;
	read(sessionPath: string): Promise<SessionFileSummary>;
	scan(sessionDirectory: string): Promise<SessionScanResult>;
	readMessages?(sessionPath: string): Promise<DesktopMessage[]>;
}

export interface ModelConnectionTester {
	test(
		profile: ModelProfile,
		apiKey: string | null,
	): Promise<{
		ok: boolean;
		status: number | null;
		latencyMs: number;
		message: string;
	}>;
}

export interface DesktopLogger {
	info(message: string, context?: Record<string, string>): void;
	error(message: string, context?: Record<string, string>): void;
	diagnostic(diagnostic: Diagnostic): void;
}

export interface DesktopHostPorts {
	window: WindowPort;
	tray: TrayPort;
	shortcut: ShortcutPort;
	singleInstance: SingleInstancePort;
	folderPicker?: FolderPickerPort;
	diagnosticsExport?: (diagnostics: readonly Diagnostic[]) => Promise<string>;
}

export type DesktopEventSubscription = (listener: DesktopEventListener) => () => void;

export type PromptDispatch = (message: string, queueMode: QueueMode) => Promise<void>;

export interface RuntimeView extends RuntimeSnapshot {}

export function asSkillCommand(command: RuntimeCommand): SkillCommand {
	return { ...command };
}
