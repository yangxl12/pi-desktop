import type {
	DesktopMessage,
	Diagnostic,
	ModelCapabilities,
	ModelCredentialStrategy,
	RuntimeCapabilities,
	RuntimeSessionRef,
	SkillCommand,
	ThinkingLevel,
} from "@earendil-works/pi-desktop-protocol";

export type { RuntimeCapabilities, RuntimeSessionRef } from "@earendil-works/pi-desktop-protocol";

export type RuntimeCapability = keyof RuntimeCapabilities;

export const DEFAULT_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
	prompt: true,
	steer: true,
	followUp: true,
	abort: true,
	sessionCreate: true,
	sessionSwitch: true,
	messageRead: true,
	streaming: true,
	toolCalling: false,
	skills: true,
	commands: true,
	thinkingLevel: true,
	modelSwitch: true,
	modelStreaming: true,
	multimodal: false,
};

export interface RuntimeModel {
	providerId: string;
	displayName: string;
	baseUrl: string;
	modelId: string;
	apiKey: string | null;
	protocol?: string;
	capabilities?: ModelCapabilities;
	credentialStrategy?: ModelCredentialStrategy;
}

export interface RuntimeStartOptions {
	cwd: string;
	sessionRef?: RuntimeSessionRef | null;
	/** @deprecated Use sessionRef. Kept for the Pi compatibility window. */
	sessionPath?: string;
	sessionDirectory: string;
	agentDirectory: string;
	globalSystemPrompt?: string;
	projectTrusted?: boolean;
	skillDirectories: string[];
	extensionPaths: string[];
	env: Record<string, string>;
	sensitiveValues: string[];
	models: RuntimeModel[];
	selectedModel?: { providerId: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	runtimeId: string;
	/** Provider selected by RuntimeService; omitted for the default provider. */
	providerId?: string;
	/** Tools are supplied by ToolGateway and translated by each provider adapter. */
	tools?: RuntimeToolDefinition[];
}

export interface RuntimeToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	call(
		argumentsValue: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{
		content: Array<Record<string, unknown>>;
		isError?: boolean;
	}>;
}

export interface RuntimeState {
	isStreaming: boolean;
	thinkingLevel: ThinkingLevel;
	/** Thinking levels the active model accepts. Absent when the provider cannot report them. */
	availableThinkingLevels?: ThinkingLevel[];
	modelProvider: string | null;
	modelId: string | null;
	/** Runtime-neutral session handle. Pi maps this to sessionPath. */
	sessionRef?: RuntimeSessionRef | null;
	/** @deprecated Use sessionRef. Providers may omit this legacy projection. */
	sessionPath?: string | null;
	sessionId: string | null;
	messageCount: number;
	providerId?: string | null;
	capabilities?: RuntimeCapabilities;
}

export type RuntimeCommand = SkillCommand;

export type AgentEvent =
	| { type: "ready"; runtimeId: string; state: RuntimeState }
	| { type: "state_changed"; runtimeId: string; state: Partial<RuntimeState> }
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

export type AgentEventPayload = AgentEvent extends infer T
	? T extends { runtimeId: string }
		? Omit<T, "runtimeId">
		: never
	: never;

export interface AgentRuntimePort {
	start(options: RuntimeStartOptions): Promise<RuntimeState>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	steer(message: string): Promise<void>;
	followUp(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<RuntimeState>;
	getMessages(): Promise<DesktopMessage[]>;
	getCommands(): Promise<RuntimeCommand[]>;
	newSession(): Promise<RuntimeState>;
	switchSession(sessionRef: RuntimeSessionRef): Promise<RuntimeState>;
	setSessionName(name: string): Promise<void>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	setModel(provider: string, modelId: string): Promise<void>;
	getCapabilities?(): RuntimeCapabilities | Promise<RuntimeCapabilities>;
	setTools?(tools: readonly RuntimeToolDefinition[]): Promise<void> | void;
	subscribe(listener: (event: AgentEvent) => void): () => void;
}

export function toRuntimeSessionRef(value: string | null | undefined): RuntimeSessionRef | null {
	return value ?? null;
}

export function fromRuntimeSessionRef(value: RuntimeSessionRef | null | undefined): string | null {
	return value ?? null;
}

export function normalizeRuntimeCapabilities(
	capabilities: Partial<RuntimeCapabilities> | undefined,
): RuntimeCapabilities {
	return { ...DEFAULT_RUNTIME_CAPABILITIES, ...capabilities };
}

export const EXTENDED_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Mirror of Pi's clamp: keep the level, otherwise try upward then downward in the extended list. */
export function clampThinkingLevel(available: readonly ThinkingLevel[], level: ThinkingLevel): ThinkingLevel {
	if (available.includes(level)) return level;
	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return available[0] ?? "off";
	for (let index = requestedIndex; index < EXTENDED_THINKING_LEVELS.length; index++) {
		const candidate = EXTENDED_THINKING_LEVELS[index];
		if (available.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index--) {
		const candidate = EXTENDED_THINKING_LEVELS[index];
		if (available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}
