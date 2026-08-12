import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopMessage, ThinkingLevel } from "@earendil-works/pi-desktop-protocol";
import {
	type AgentEvent,
	type AgentRuntimePort,
	clampThinkingLevel,
	DEFAULT_RUNTIME_CAPABILITIES,
	type RuntimeCommand,
	type RuntimeStartOptions,
	type RuntimeState,
} from "./runtime-contract.ts";

export interface FakeRuntimeOptions {
	response?: string;
	streamDelayMs?: number;
	/** When set, thinking levels are clamped to this list, mirroring Pi's model capability clamping. */
	availableThinkingLevels?: ThinkingLevel[];
}

/** Small deterministic provider used by core contract tests and local previews. */
export class FakeAgentRuntime implements AgentRuntimePort {
	private readonly options: FakeRuntimeOptions;
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private readonly messages: DesktopMessage[] = [];
	private state: RuntimeState = {
		isStreaming: false,
		thinkingLevel: "off",
		modelProvider: null,
		modelId: null,
		sessionPath: null,
		sessionRef: null,
		sessionId: null,
		messageCount: 0,
		capabilities: DEFAULT_RUNTIME_CAPABILITIES,
	};
	private started = false;
	private generation = 0;
	private currentMessage: DesktopMessage | undefined;
	private runtimeId = "fake-runtime";

	constructor(options: FakeRuntimeOptions = {}) {
		this.options = options;
	}

	async start(options: RuntimeStartOptions): Promise<RuntimeState> {
		this.started = true;
		this.runtimeId = options.runtimeId;
		await mkdir(options.sessionDirectory, { recursive: true });
		const sessionRef =
			options.sessionRef ?? options.sessionPath ?? join(options.sessionDirectory, `fake-${randomUUID()}.jsonl`);
		if (!options.sessionRef && !options.sessionPath)
			await writeFile(
				sessionRef,
				`${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: options.cwd })}\n`,
			);
		this.state = {
			...this.state,
			sessionRef,
			sessionPath: sessionRef,
			sessionId: randomUUID(),
			thinkingLevel: this.options.availableThinkingLevels
				? clampThinkingLevel(this.options.availableThinkingLevels, options.thinkingLevel)
				: options.thinkingLevel,
			modelProvider: options.selectedModel?.providerId ?? null,
			modelId: options.selectedModel?.modelId ?? null,
			messageCount: this.messages.length,
			...(this.options.availableThinkingLevels
				? { availableThinkingLevels: [...this.options.availableThinkingLevels] }
				: {}),
		};
		this.emit({ type: "ready", runtimeId: this.runtimeId, state: { ...this.state } });
		return { ...this.state };
	}

	async stop(): Promise<void> {
		this.started = false;
		this.generation += 1;
		this.state.isStreaming = false;
	}

	async prompt(message: string): Promise<void> {
		if (!this.started) throw new Error("Fake runtime is not started");
		const generation = ++this.generation;
		const user = this.message("user", message, "finished");
		this.messages.push(user);
		this.emit({ type: "message_started", runtimeId: this.runtimeId, message: this.copy(user) });
		this.emit({ type: "message_finished", runtimeId: this.runtimeId, message: this.copy(user) });
		this.state.isStreaming = true;
		this.currentMessage = this.message("assistant", "", "streaming");
		this.messages.push(this.currentMessage);
		this.emit({ type: "message_started", runtimeId: this.runtimeId, message: this.copy(this.currentMessage) });
		for (const character of this.options.response ?? `Echo: ${message}`) {
			if (this.options.streamDelayMs)
				await new Promise((resolve) => setTimeout(resolve, this.options.streamDelayMs));
			if (!this.started || generation !== this.generation) return;
			this.currentMessage.parts[0].text += character;
			this.emit({
				type: "message_delta",
				runtimeId: this.runtimeId,
				messageId: this.currentMessage.id,
				part: "text",
				delta: character,
			});
		}
		this.currentMessage.status = "finished";
		this.state.isStreaming = false;
		this.state.messageCount = this.messages.length;
		this.emit({ type: "message_finished", runtimeId: this.runtimeId, message: this.copy(this.currentMessage) });
		this.emit({ type: "state_changed", runtimeId: this.runtimeId, state: { isStreaming: false } });
	}

	steer(message: string): Promise<void> {
		return this.prompt(message);
	}

	followUp(message: string): Promise<void> {
		return this.prompt(message);
	}

	async abort(): Promise<void> {
		this.generation += 1;
		this.state.isStreaming = false;
		if (this.currentMessage?.status === "streaming") this.currentMessage.status = "aborted";
		this.emit({ type: "aborted", runtimeId: this.runtimeId, messageId: this.currentMessage?.id });
	}

	getState(): Promise<RuntimeState> {
		return Promise.resolve({ ...this.state });
	}

	getMessages(): Promise<DesktopMessage[]> {
		return Promise.resolve(this.messages.map((message) => this.copy(message)));
	}

	getCommands(): Promise<RuntimeCommand[]> {
		return Promise.resolve([
			{ name: "help", description: "Show help", source: "fake" },
			{ name: "skill:review", description: "Review the current project", source: "skill", scope: "user" },
		]);
	}

	async newSession(): Promise<RuntimeState> {
		this.messages.length = 0;
		const sessionRef = `fake-sessions/fake-${randomUUID()}.jsonl`;
		this.state = { ...this.state, sessionRef, sessionPath: sessionRef, sessionId: randomUUID(), messageCount: 0 };
		return { ...this.state };
	}

	async switchSession(sessionRef: string): Promise<RuntimeState> {
		this.messages.length = 0;
		this.state = { ...this.state, sessionRef, sessionPath: sessionRef, sessionId: randomUUID(), messageCount: 0 };
		return { ...this.state };
	}

	setSessionName(_name: string): Promise<void> {
		return Promise.resolve();
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.state.thinkingLevel = this.options.availableThinkingLevels
			? clampThinkingLevel(this.options.availableThinkingLevels, level)
			: level;
		return Promise.resolve();
	}

	setModel(provider: string, modelId: string): Promise<void> {
		this.state.modelProvider = provider;
		this.state.modelId = modelId;
		return Promise.resolve();
	}

	getCapabilities() {
		return { ...DEFAULT_RUNTIME_CAPABILITIES };
	}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private message(role: DesktopMessage["role"], text: string, status: DesktopMessage["status"]): DesktopMessage {
		return { id: randomUUID(), role, parts: [{ type: "text", text }], createdAt: new Date().toISOString(), status };
	}

	private copy(message: DesktopMessage): DesktopMessage {
		return { ...message, parts: message.parts.map((part) => ({ ...part })) };
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
