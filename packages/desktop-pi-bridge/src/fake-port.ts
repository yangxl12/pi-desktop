import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	PiAgentEvent,
	PiAgentPort,
	PiAgentState,
	PiCommandInfo,
	PiRuntimeOptions,
} from "@earendil-works/pi-desktop-core";
import { clampThinkingLevel, DEFAULT_RUNTIME_CAPABILITIES } from "@earendil-works/pi-desktop-core";
import type { DesktopMessage, ThinkingLevel } from "@earendil-works/pi-desktop-protocol";

function assistantMessage(text = ""): DesktopMessage {
	return {
		id: randomUUID(),
		role: "assistant",
		parts: [{ type: "text", text }],
		createdAt: new Date().toISOString(),
		status: "streaming",
	};
}

export interface FakePiAgentPortOptions {
	response?: string;
	streamDelayMs?: number;
	/** When set, thinking levels are clamped to this list, mirroring Pi's model capability clamping. */
	availableThinkingLevels?: ThinkingLevel[];
}

export class FakePiAgentPort implements PiAgentPort {
	private readonly options: FakePiAgentPortOptions;
	private readonly listeners = new Set<(event: PiAgentEvent) => void>();
	private readonly messages: DesktopMessage[] = [];
	private state: PiAgentState = {
		isStreaming: false,
		thinkingLevel: "off",
		modelProvider: null,
		modelId: null,
		sessionPath: null,
		sessionRef: null,
		sessionId: null,
		messageCount: 0,
		capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES },
	};
	private started = false;
	private currentMessage: DesktopMessage | undefined;
	private runtimeId = "fake-runtime";
	private generation = 0;

	constructor(options: FakePiAgentPortOptions = {}) {
		this.options = options;
	}

	async start(options: PiRuntimeOptions): Promise<PiAgentState> {
		this.started = true;
		this.runtimeId = options.runtimeId;
		await mkdir(options.sessionDirectory, { recursive: true });
		const sessionPath = options.sessionPath ?? join(options.sessionDirectory, `fake-${randomUUID()}.jsonl`);
		if (!options.sessionPath) {
			await writeFile(
				sessionPath,
				`${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: options.cwd })}\n`,
			);
		}
		this.state = {
			...this.state,
			sessionPath,
			sessionRef: sessionPath,
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
		if (!this.started) throw new Error("Fake Pi runtime is not started");
		const generation = ++this.generation;
		const user: DesktopMessage = {
			id: randomUUID(),
			role: "user",
			parts: [{ type: "text", text: message }],
			createdAt: new Date().toISOString(),
			status: "finished",
		};
		this.messages.push(user);
		this.emit({
			type: "message_started",
			runtimeId: this.runtimeId,
			message: { ...user, parts: user.parts.map((part) => ({ ...part })) },
		});
		this.emit({
			type: "message_finished",
			runtimeId: this.runtimeId,
			message: { ...user, parts: user.parts.map((part) => ({ ...part })) },
		});
		this.state.isStreaming = true;
		this.currentMessage = assistantMessage();
		this.messages.push(this.currentMessage);
		this.emit({
			type: "message_started",
			runtimeId: this.runtimeId,
			message: { ...this.currentMessage, parts: this.currentMessage.parts.map((part) => ({ ...part })) },
		});
		const response = this.options.response ?? `Echo: ${message}`;
		for (const character of response) {
			await new Promise((resolve) => setTimeout(resolve, this.options.streamDelayMs ?? 0));
			if (!this.started || generation !== this.generation) return;
			const part = this.currentMessage.parts[0];
			part.text += character;
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
		this.emit({
			type: "message_finished",
			runtimeId: this.runtimeId,
			message: { ...this.currentMessage, parts: this.currentMessage.parts.map((part) => ({ ...part })) },
		});
		this.emit({ type: "state_changed", runtimeId: this.runtimeId, state: { isStreaming: false } });
	}

	async steer(message: string): Promise<void> {
		await this.prompt(message);
	}
	async followUp(message: string): Promise<void> {
		await this.prompt(message);
	}

	async abort(): Promise<void> {
		this.generation += 1;
		this.state.isStreaming = false;
		if (this.currentMessage?.status === "streaming") this.currentMessage.status = "aborted";
		this.emit({ type: "aborted", runtimeId: this.runtimeId, messageId: this.currentMessage?.id });
	}

	async getState(): Promise<PiAgentState> {
		return { ...this.state };
	}

	async getMessages(): Promise<DesktopMessage[]> {
		return this.messages.map((message) => ({ ...message, parts: message.parts.map((part) => ({ ...part })) }));
	}

	async getCommands(): Promise<PiCommandInfo[]> {
		return [
			{ name: "help", description: "Show help", source: "pi" },
			{
				name: "skill:review",
				description: "Review the current project",
				source: "skill",
				path: "memory://review",
				scope: "user",
			},
		];
	}

	async newSession(): Promise<PiAgentState> {
		this.messages.length = 0;
		const sessionPath = join("fake-sessions", `fake-${randomUUID()}.jsonl`);
		this.state = {
			...this.state,
			sessionPath,
			sessionRef: sessionPath,
			sessionId: randomUUID(),
			messageCount: 0,
		};
		return { ...this.state };
	}

	async switchSession(sessionPath: string): Promise<PiAgentState> {
		this.messages.length = 0;
		this.state = { ...this.state, sessionPath, sessionId: randomUUID(), messageCount: 0 };
		this.state.sessionRef = sessionPath;
		return { ...this.state };
	}

	async setSessionName(_name: string): Promise<void> {}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.state.thinkingLevel = this.options.availableThinkingLevels
			? clampThinkingLevel(this.options.availableThinkingLevels, level)
			: level;
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		this.state.modelProvider = provider;
		this.state.modelId = modelId;
	}

	subscribe(listener: (event: PiAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: PiAgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
