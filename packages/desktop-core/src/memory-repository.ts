import { randomUUID } from "node:crypto";
import type {
	AppSettings,
	ConversationIndex,
	McpServerProfile,
	ModelProfile,
	Project,
} from "@earendil-works/pi-desktop-protocol";
import type { MetadataRepository, SecretStore } from "./ports.ts";

export const DEFAULT_APP_SETTINGS: AppSettings = {
	globalSystemPrompt: "",
	invokeShortcut: "Ctrl+Shift+0",
	defaultModelProfileId: null,
	closeToTray: true,
	skillDirectories: [],
	schemaVersion: 1,
};

export class MemoryMetadataRepository implements MetadataRepository {
	private settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
	private readonly projects = new Map<string, Project>();
	private readonly conversations = new Map<string, ConversationIndex>();
	private readonly models = new Map<string, ModelProfile>();
	private readonly mcpServers = new Map<string, McpServerProfile>();

	async initialize(): Promise<void> {}

	async loadSettings(): Promise<AppSettings> {
		return { ...this.settings };
	}

	async saveSettings(settings: AppSettings): Promise<void> {
		this.settings = { ...settings };
	}

	async listProjects(): Promise<Project[]> {
		return [...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async saveProject(project: Project): Promise<void> {
		this.projects.set(project.id, { ...project });
	}

	async deleteProject(projectId: string): Promise<void> {
		this.projects.delete(projectId);
		for (const conversation of this.conversations.values()) {
			if (conversation.projectId === projectId) this.conversations.delete(conversation.id);
		}
	}

	async listConversations(projectId: string): Promise<ConversationIndex[]> {
		return [...this.conversations.values()]
			.filter((conversation) => conversation.projectId === projectId)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async saveConversation(conversation: ConversationIndex): Promise<void> {
		this.conversations.set(conversation.id, { ...conversation });
	}

	async deleteConversation(sessionId: string): Promise<void> {
		this.conversations.delete(sessionId);
	}

	async listModels(): Promise<ModelProfile[]> {
		return [...this.models.values()].map((model) => ({ ...model }));
	}

	async saveModel(profile: ModelProfile): Promise<void> {
		this.models.set(profile.id, { ...profile });
	}

	async deleteModel(profileId: string): Promise<void> {
		this.models.delete(profileId);
	}

	async listMcpServers(): Promise<McpServerProfile[]> {
		return [...this.mcpServers.values()].map((profile) => ({
			...profile,
			args: [...profile.args],
			env: { ...profile.env },
		}));
	}

	async saveMcpServer(profile: McpServerProfile): Promise<void> {
		this.mcpServers.set(profile.id, { ...profile, args: [...profile.args], env: { ...profile.env } });
	}

	async deleteMcpServer(serverId: string): Promise<void> {
		this.mcpServers.delete(serverId);
	}

	async close(): Promise<void> {}
}

export class MemorySecretStore implements SecretStore {
	private readonly values = new Map<string, string>();

	async set(value: string, ref = `secret_${randomUUID()}`): Promise<string> {
		this.values.set(ref, value);
		return ref;
	}

	async get(ref: string): Promise<string | null> {
		return this.values.get(ref) ?? null;
	}

	async delete(ref: string): Promise<void> {
		this.values.delete(ref);
	}
}
