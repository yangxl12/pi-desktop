import type {
	AppSettings,
	ConversationIndex,
	DesktopEventListener,
	DesktopMessage,
	Diagnostic,
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

export interface PiRuntimeModel {
	providerId: string;
	displayName: string;
	baseUrl: string;
	modelId: string;
	apiKey: string | null;
}

export interface PiRuntimeOptions {
	cwd: string;
	sessionPath?: string;
	sessionDirectory: string;
	agentDirectory: string;
	globalSystemPrompt?: string;
	projectTrusted?: boolean;
	skillDirectories: string[];
	extensionPaths: string[];
	env: Record<string, string>;
	sensitiveValues: string[];
	models: PiRuntimeModel[];
	selectedModel?: { providerId: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	runtimeId: string;
}

export interface PiAgentState {
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	modelProvider: string | null;
	modelId: string | null;
	sessionPath: string | null;
	sessionId: string | null;
	messageCount: number;
}

export interface PiCommandInfo {
	name: string;
	description?: string;
	source: string;
	path?: string;
	scope?: "user" | "project" | "temporary";
}

export type PiAgentEvent =
	| { type: "ready"; runtimeId: string; state: PiAgentState }
	| { type: "state_changed"; runtimeId: string; state: Partial<PiAgentState> }
	| { type: "message_started"; runtimeId: string; message: DesktopMessage }
	| { type: "message_delta"; runtimeId: string; messageId: string; part: "text" | "thinking"; delta: string }
	| { type: "message_finished"; runtimeId: string; message: DesktopMessage }
	| { type: "tool_started"; runtimeId: string; messageId: string; toolName: string; toolCallId: string }
	| { type: "tool_update"; runtimeId: string; messageId: string; toolCallId: string; text: string }
	| {
			type: "tool_finished";
			runtimeId: string;
			messageId: string;
			toolCallId: string;
			text: string;
			failed: boolean;
	  }
	| { type: "aborted"; runtimeId: string; messageId?: string }
	| { type: "diagnostic"; runtimeId: string; level: Diagnostic["level"]; message: string }
	| { type: "error"; runtimeId: string; error: string };

export type PiAgentEventPayload = PiAgentEvent extends infer T
	? T extends { runtimeId: string }
		? Omit<T, "runtimeId">
		: never
	: never;

export interface PiAgentPort {
	start(options: PiRuntimeOptions): Promise<PiAgentState>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<PiAgentState>;
	getMessages(): Promise<DesktopMessage[]>;
	getCommands(): Promise<PiCommandInfo[]>;
	newSession(): Promise<PiAgentState>;
	switchSession(sessionPath: string): Promise<PiAgentState>;
	setSessionName(name: string): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	subscribe(listener: (event: PiAgentEvent) => void): () => void;
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
	subscribe(listener: (event: { type: string; serverId: string }) => void): () => void;
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
}

export interface SessionScanResult {
	sessions: SessionFileSummary[];
	diagnostics: string[];
}

export interface SessionFileRepository {
	exists(sessionPath: string): Promise<boolean>;
	read(sessionPath: string): Promise<SessionFileSummary>;
	scan(sessionDirectory: string): Promise<SessionScanResult>;
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

export function asSkillCommand(command: PiCommandInfo): SkillCommand {
	return { ...command };
}
