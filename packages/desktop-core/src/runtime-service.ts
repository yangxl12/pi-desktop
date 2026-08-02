import type { DesktopMessage, ThinkingLevel } from "@earendil-works/pi-desktop-protocol";
import type {
	AgentEvent,
	AgentRuntimePort,
	RuntimeCapabilities,
	RuntimeCommand,
	RuntimeSessionRef,
	RuntimeStartOptions,
	RuntimeState,
	RuntimeToolDefinition,
} from "./runtime-contract.ts";
import type { RuntimeProviderRegistry, RuntimeServiceSnapshot } from "./runtime-provider.ts";

/** Serializes lifecycle commands and drops events from replaced runtime generations. */
export class RuntimeService implements AgentRuntimePort {
	private readonly registry: RuntimeProviderRegistry;
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private current: AgentRuntimePort | undefined;
	private currentUnsubscribe: (() => void) | undefined;
	private generation = 0;
	private queue: Promise<unknown> = Promise.resolve();
	private state: RuntimeServiceSnapshot = {
		isStreaming: false,
		thinkingLevel: "off",
		modelProvider: null,
		modelId: null,
		sessionRef: null,
		sessionPath: null,
		sessionId: null,
		messageCount: 0,
		capabilities: undefined,
		providerId: null,
		generation: 0,
		status: "stopped",
	};

	constructor(registry: RuntimeProviderRegistry) {
		this.registry = registry;
	}

	get snapshot(): RuntimeServiceSnapshot {
		return { ...this.state, capabilities: this.state.capabilities ? { ...this.state.capabilities } : undefined };
	}

	start(options: RuntimeStartOptions): Promise<RuntimeState> {
		return this.enqueue(async () => {
			await this.stopCurrent();
			const provider = this.registry.get(options.providerId);
			const generation = ++this.generation;
			this.state = { ...this.state, providerId: provider.manifest.id, generation, status: "starting" };
			const runtime = await provider.create({ ...options, providerId: provider.manifest.id });
			this.current = runtime;
			this.currentUnsubscribe = runtime.subscribe((event) => {
				if (event.runtimeId !== options.runtimeId || generation !== this.generation) return;
				this.state = {
					...this.state,
					...(event.type === "ready" ? event.state : event.type === "state_changed" ? event.state : {}),
					status: event.type === "error" ? "error" : event.type === "ready" ? "ready" : this.state.status,
				};
				this.emit(event);
			});
			try {
				const state = await runtime.start({ ...options, providerId: provider.manifest.id });
				const capabilities = { ...(state.capabilities ?? {}), ...provider.manifest.capabilities };
				this.state = {
					...this.state,
					...state,
					capabilities,
					providerId: provider.manifest.id,
					generation,
					status: "ready",
				};
				return { ...state, providerId: provider.manifest.id, capabilities };
			} catch (error) {
				this.state = { ...this.state, status: "error" };
				await this.stopCurrent();
				throw error;
			}
		});
	}

	stop(): Promise<void> {
		return this.enqueue(async () => {
			this.generation += 1;
			await this.stopCurrent();
			this.state = { ...this.state, status: "stopped", providerId: null, generation: this.generation };
		});
	}

	prompt(message: string): Promise<void> {
		return this.command((runtime) => runtime.prompt(message));
	}
	steer(message: string): Promise<void> {
		return this.command((runtime) => runtime.steer(message));
	}
	followUp(message: string): Promise<void> {
		return this.command((runtime) => runtime.followUp(message));
	}
	abort(): Promise<void> {
		return this.command((runtime) => runtime.abort());
	}

	getState(): Promise<RuntimeState> {
		return this.current ? this.current.getState() : Promise.resolve({ ...this.state });
	}
	getMessages(): Promise<DesktopMessage[]> {
		return this.current ? this.current.getMessages() : Promise.resolve([]);
	}
	getCommands(): Promise<RuntimeCommand[]> {
		return this.current ? this.current.getCommands() : Promise.resolve([]);
	}
	newSession(): Promise<RuntimeState> {
		return this.commandState((runtime) => runtime.newSession());
	}
	switchSession(sessionRef: RuntimeSessionRef): Promise<RuntimeState> {
		return this.commandState((runtime) => runtime.switchSession(sessionRef));
	}
	setSessionName(name: string): Promise<void> {
		return this.command((runtime) => runtime.setSessionName(name));
	}
	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.command((runtime) => runtime.setThinkingLevel(level));
	}
	setModel(provider: string, modelId: string): Promise<void> {
		return this.command((runtime) => runtime.setModel(provider, modelId));
	}
	getCapabilities(): RuntimeCapabilities {
		return this.state.capabilities ?? this.registry.get().manifest.capabilities;
	}
	setTools(tools: readonly RuntimeToolDefinition[]): Promise<void> {
		return this.command((runtime) => runtime.setTools?.(tools));
	}
	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private command(task: (runtime: AgentRuntimePort) => Promise<void> | void): Promise<void> {
		return this.enqueue(async () => {
			const runtime = this.requireCurrent();
			await task(runtime);
		});
	}

	private commandState(task: (runtime: AgentRuntimePort) => Promise<RuntimeState>): Promise<RuntimeState> {
		return this.enqueue(async () => {
			const state = await task(this.requireCurrent());
			this.state = { ...this.state, ...state };
			return state;
		});
	}

	private requireCurrent(): AgentRuntimePort {
		if (!this.current) throw new Error("No runtime is started");
		return this.current;
	}

	private async stopCurrent(): Promise<void> {
		const runtime = this.current;
		this.current = undefined;
		this.currentUnsubscribe?.();
		this.currentUnsubscribe = undefined;
		if (runtime) await runtime.stop();
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.queue.then(task, task);
		this.queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private emit(event: AgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
