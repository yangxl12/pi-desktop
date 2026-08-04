import type {
	ModelCapabilities,
	ModelCredentialStrategy,
	ModelProfile,
	ModelProtocol,
} from "@earendil-works/pi-desktop-protocol";
import type { SecretStore } from "./ports.ts";
import type { RuntimeModel } from "./runtime-contract.ts";

export const DEFAULT_MODEL_CAPABILITIES: ModelCapabilities = {
	streaming: true,
	toolCalling: true,
	thinking: true,
	multimodal: false,
};

export interface ModelGatewayDescriptor {
	profile: ModelProfile;
	protocol: ModelProtocol;
	capabilities: ModelCapabilities;
	credentialStrategy: ModelCredentialStrategy;
}

export function modelProtocol(profile: Pick<ModelProfile, "protocol" | "providerId">): ModelProtocol {
	if (profile.protocol) return profile.protocol;
	if (profile.providerId === "local" || profile.providerId.startsWith("local-")) return "local";
	return "openai-compatible";
}

export function modelCapabilities(profile: Pick<ModelProfile, "capabilities" | "protocol">): ModelCapabilities {
	const defaults =
		profile.protocol === "anthropic"
			? { ...DEFAULT_MODEL_CAPABILITIES, thinking: false }
			: DEFAULT_MODEL_CAPABILITIES;
	const contextWindow = profile.capabilities?.contextWindow;
	const validContextWindow = typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0;
	return {
		...defaults,
		...profile.capabilities,
		...(validContextWindow ? { contextWindow } : { contextWindow: undefined }),
	};
}

export function modelCredentialStrategy(
	profile: Pick<ModelProfile, "credentialRef" | "credentialStrategy">,
): ModelCredentialStrategy {
	return profile.credentialStrategy ?? (profile.credentialRef ? "os-secret" : "none");
}

/**
 * Resolves stored model metadata and credentials at the Host boundary. The
 * renderer and SQLite only ever see credentialRef; runtime adapters receive
 * the short-lived apiKey value through this gateway.
 */
export class ModelGateway {
	private readonly secrets: SecretStore | undefined;

	constructor(secrets?: SecretStore) {
		this.secrets = secrets;
	}

	describe(profile: ModelProfile): ModelGatewayDescriptor {
		return {
			profile: { ...profile, capabilities: profile.capabilities ? { ...profile.capabilities } : undefined },
			protocol: modelProtocol(profile),
			capabilities: modelCapabilities(profile),
			credentialStrategy: modelCredentialStrategy(profile),
		};
	}

	async resolve(profile: ModelProfile): Promise<RuntimeModel> {
		const descriptor = this.describe(profile);
		const apiKey = profile.credentialRef && this.secrets ? await this.secrets.get(profile.credentialRef) : null;
		return {
			providerId: profile.providerId,
			displayName: profile.displayName,
			baseUrl: profile.baseUrl,
			modelId: profile.modelId,
			apiKey,
			protocol: descriptor.protocol,
			capabilities: descriptor.capabilities,
			credentialStrategy: descriptor.credentialStrategy,
		};
	}

	async resolveEnabled(profiles: readonly ModelProfile[]): Promise<RuntimeModel[]> {
		return Promise.all(profiles.filter((profile) => profile.enabled).map((profile) => this.resolve(profile)));
	}
}
