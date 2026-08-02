import type { AgentRuntimePort, RuntimeCapabilities, RuntimeStartOptions, RuntimeState } from "./runtime-contract.ts";

export interface AgentRuntimeProviderManifest {
	id: string;
	version: string;
	description?: string;
	capabilities: RuntimeCapabilities;
	codecIds?: readonly string[];
	toolAdapterVersion?: string;
}

export interface AgentRuntimeProvider {
	readonly manifest: AgentRuntimeProviderManifest;
	create(options: RuntimeStartOptions): Promise<AgentRuntimePort> | AgentRuntimePort;
	healthCheck?(): Promise<{ ok: boolean; message?: string }>;
	dispose?(): Promise<void> | void;
}

export class RuntimeProviderRegistry {
	private readonly providers = new Map<string, AgentRuntimeProvider>();
	private defaultProviderId: string | undefined;

	register(provider: AgentRuntimeProvider, options: { isDefault?: boolean } = {}): void {
		const id = provider.manifest.id.trim();
		if (!id) throw new Error("Runtime provider id is required");
		if (this.providers.has(id)) throw new Error(`Runtime provider already registered: ${id}`);
		this.providers.set(id, provider);
		if (options.isDefault || !this.defaultProviderId) this.defaultProviderId = id;
	}

	unregister(id: string): AgentRuntimeProvider | undefined {
		const provider = this.providers.get(id);
		if (!provider) return undefined;
		this.providers.delete(id);
		if (this.defaultProviderId === id) this.defaultProviderId = this.providers.keys().next().value;
		return provider;
	}

	get(id?: string): AgentRuntimeProvider {
		const providerId = id ?? this.defaultProviderId;
		const provider = providerId ? this.providers.get(providerId) : undefined;
		if (!provider) throw new Error(id ? `Runtime provider not found: ${id}` : "No runtime provider is registered");
		return provider;
	}

	list(): AgentRuntimeProviderManifest[] {
		return [...this.providers.values()].map((provider) => ({ ...provider.manifest }));
	}

	get defaultId(): string | undefined {
		return this.defaultProviderId;
	}
}

export interface RuntimeServiceSnapshot extends RuntimeState {
	providerId: string | null;
	generation: number;
	status: "stopped" | "starting" | "ready" | "error";
}
