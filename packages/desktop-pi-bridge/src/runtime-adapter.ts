import type {
	AgentRuntimePort,
	AgentRuntimeProvider,
	AgentRuntimeProviderManifest,
	RuntimeStartOptions,
	RuntimeToolDefinition,
} from "@earendil-works/pi-desktop-core";
import { DEFAULT_RUNTIME_CAPABILITIES } from "@earendil-works/pi-desktop-core";
import { RecoveringPiAgentPort, type RecoveringPiAgentPortOptions } from "./recovering-port.ts";
import { RpcPiAgentPort, type RpcPiAgentPortOptions } from "./rpc-port.ts";

export const PI_RUNTIME_MANIFEST: AgentRuntimeProviderManifest = {
	id: "pi",
	version: "0.83.0",
	description: "Pi coding-agent JSONL runtime",
	capabilities: { ...DEFAULT_RUNTIME_CAPABILITIES, toolCalling: true },
	codecIds: ["pi-jsonl"],
	toolAdapterVersion: "1",
};

export interface PiRuntimeAdapterOptions {
	rpc?: RpcPiAgentPortOptions;
	recovery?: RecoveringPiAgentPortOptions;
}

/** Pi-specific process/RPC adapter. Core only sees AgentRuntimePort. */
export class PiRuntimeAdapter implements AgentRuntimePort {
	readonly manifest = PI_RUNTIME_MANIFEST;
	private readonly runtime: RecoveringPiAgentPort;

	constructor(options: PiRuntimeAdapterOptions = {}) {
		this.runtime = new RecoveringPiAgentPort(
			new RpcPiAgentPort({ ...options.rpc, enableToolBridge: options.rpc?.enableToolBridge ?? true }),
			options.recovery,
		);
	}

	start(options: RuntimeStartOptions) {
		return this.runtime.start(options);
	}
	stop() {
		return this.runtime.stop();
	}
	prompt(message: string) {
		return this.runtime.prompt(message);
	}
	steer(message: string) {
		return this.runtime.steer(message);
	}
	followUp(message: string) {
		return this.runtime.followUp(message);
	}
	abort() {
		return this.runtime.abort();
	}
	getState() {
		return this.runtime.getState();
	}
	getMessages() {
		return this.runtime.getMessages();
	}
	getCommands() {
		return this.runtime.getCommands();
	}
	newSession() {
		return this.runtime.newSession();
	}
	switchSession(sessionRef: string) {
		return this.runtime.switchSession(sessionRef);
	}
	setSessionName(name: string) {
		return this.runtime.setSessionName(name);
	}
	setThinkingLevel(level: Parameters<AgentRuntimePort["setThinkingLevel"]>[0]) {
		return this.runtime.setThinkingLevel(level);
	}
	setModel(provider: string, modelId: string) {
		return this.runtime.setModel(provider, modelId);
	}
	setTools(tools: readonly RuntimeToolDefinition[]) {
		return this.runtime.setTools(tools);
	}
	subscribe(listener: Parameters<AgentRuntimePort["subscribe"]>[0]) {
		return this.runtime.subscribe(listener);
	}
	getCapabilities() {
		return this.manifest.capabilities;
	}
}

export function createPiRuntimeProvider(options: PiRuntimeAdapterOptions = {}): AgentRuntimeProvider {
	return {
		manifest: PI_RUNTIME_MANIFEST,
		create: () => new PiRuntimeAdapter(options),
		healthCheck: async () => ({ ok: true, message: "Pi adapter is available" }),
	};
}
