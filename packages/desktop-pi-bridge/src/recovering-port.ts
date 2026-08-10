import type {
	PiAgentEvent,
	PiAgentPort,
	PiAgentState,
	PiCommandInfo,
	PiRuntimeOptions,
	RuntimeState,
	RuntimeToolDefinition,
} from "@earendil-works/pi-desktop-core";
import type { DesktopMessage, ThinkingLevel } from "@earendil-works/pi-desktop-protocol";

export interface RecoveringPiAgentPortOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
}

export class RecoveringPiAgentPort implements PiAgentPort {
	private readonly inner: PiAgentPort;
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly listeners = new Set<(event: PiAgentEvent) => void>();
	private runtimeOptions: PiRuntimeOptions | undefined;
	private attempts = 0;
	private recovering = false;
	private stopping = false;

	constructor(inner: PiAgentPort, options: RecoveringPiAgentPortOptions = {}) {
		this.inner = inner;
		this.maxAttempts = options.maxAttempts ?? 3;
		this.baseDelayMs = options.baseDelayMs ?? 500;
		inner.subscribe((event) => this.handleEvent(event));
	}

	async start(options: PiRuntimeOptions): Promise<PiAgentState> {
		this.stopping = false;
		this.attempts = 0;
		this.runtimeOptions = {
			...options,
			skillDirectories: [...options.skillDirectories],
			models: options.models.map((model) => ({ ...model })),
		};
		const state = await this.inner.start(this.runtimeOptions);
		this.rememberSession(state);
		return state;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.runtimeOptions = undefined;
		await this.inner.stop();
	}

	prompt(message: string): Promise<void> {
		return this.inner.prompt(message);
	}
	steer(message: string): Promise<void> {
		return this.inner.steer(message);
	}
	followUp(message: string): Promise<void> {
		return this.inner.followUp(message);
	}
	abort(): Promise<void> {
		return this.inner.abort();
	}
	getMessages(): Promise<DesktopMessage[]> {
		return this.inner.getMessages();
	}
	getCommands(): Promise<PiCommandInfo[]> {
		return this.inner.getCommands();
	}
	setSessionName(name: string): Promise<void> {
		return this.inner.setSessionName(name);
	}
	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.inner.setThinkingLevel(level);
	}
	setModel(provider: string, modelId: string): Promise<void> {
		return this.inner.setModel(provider, modelId);
	}
	setTools(tools: readonly RuntimeToolDefinition[]): Promise<void> | void {
		return this.inner.setTools?.(tools);
	}

	async getState(): Promise<PiAgentState> {
		const state = await this.inner.getState();
		this.rememberSession(state);
		return state;
	}

	async newSession(): Promise<PiAgentState> {
		const state = await this.inner.newSession();
		this.rememberSession(state);
		return state;
	}

	async switchSession(sessionPath: string): Promise<PiAgentState> {
		if (this.runtimeOptions) {
			this.runtimeOptions.sessionPath = sessionPath;
			this.runtimeOptions.sessionRef = sessionPath;
		}
		const state = await this.inner.switchSession(sessionPath);
		this.rememberSession(state);
		return state;
	}

	subscribe(listener: (event: PiAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private handleEvent(event: PiAgentEvent): void {
		this.emit(event);
		if (event.type === "error" && !this.stopping && this.runtimeOptions) void this.recover();
		if (event.type === "ready") {
			this.attempts = 0;
			this.rememberSession(event.state);
		}
	}

	private async recover(): Promise<void> {
		if (this.recovering || !this.runtimeOptions) return;
		this.recovering = true;
		try {
			while (!this.stopping && this.runtimeOptions && this.attempts < this.maxAttempts) {
				const options: PiRuntimeOptions = this.runtimeOptions;
				this.attempts += 1;
				this.emit({
					type: "diagnostic",
					runtimeId: options.runtimeId,
					level: "warning",
					message: `Restarting Pi runtime after crash (attempt ${this.attempts}/${this.maxAttempts})`,
				});
				await new Promise<void>((resolve) => setTimeout(resolve, this.baseDelayMs * 2 ** (this.attempts - 1)));
				// The runtime may have been stopped or replaced while we were waiting.
				if (this.stopping || this.runtimeOptions !== options) return;
				try {
					const state = await this.inner.start(options);
					if (this.stopping || this.runtimeOptions !== options) return;
					this.rememberSession(state);
					this.attempts = 0;
					return;
				} catch (error: unknown) {
					if (this.stopping || this.runtimeOptions !== options) return;
					this.emit({
						type: "diagnostic",
						runtimeId: options.runtimeId,
						level: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			}
		} catch {
			// Recovery must never take down the host process.
		} finally {
			this.recovering = false;
		}
	}

	private rememberSession(state: RuntimeState): void {
		const sessionRef = state.sessionRef ?? state.sessionPath;
		if (this.runtimeOptions && sessionRef) {
			this.runtimeOptions.sessionPath = state.sessionPath ?? sessionRef;
			this.runtimeOptions.sessionRef = sessionRef;
		}
	}

	private emit(event: PiAgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
