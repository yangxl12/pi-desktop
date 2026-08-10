import { randomUUID } from "node:crypto";
import type {
	AppSettings,
	ConversationIndex,
	McpServerProfile,
	ModelProfile,
	Project,
	SkillInstallationSnapshot,
} from "@earendil-works/pi-desktop-protocol";
import type { MetadataRepository, SecretStore } from "./ports.ts";

export const DEFAULT_APP_SETTINGS: AppSettings = {
	globalSystemPrompt: "",
	invokeShortcut: "Alt+Shift+O",
	defaultModelProfileId: null,
	defaultThinkingLevel: "high",
	conversationFontSize: 16,
	sidebarFontSize: 14,
	closeToTray: true,
	skillDirectories: [],
	locale: "zh-CN",
	theme: "dark",
	webSearch: { provider: "disabled", credentialRef: null },
	schemaVersion: 5,
};

export class MemoryMetadataRepository implements MetadataRepository {
	private settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
	private readonly projects = new Map<string, Project>();
	private readonly conversations = new Map<string, ConversationIndex>();
	private readonly models = new Map<string, ModelProfile>();
	private readonly mcpServers = new Map<string, McpServerProfile>();
	private readonly skillInstallations = new Map<string, SkillInstallationSnapshot>();

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

	async listConversationPage(projectId: string, limit: number, cursor?: string) {
		const conversations = await this.listConversations(projectId);
		const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
		const safeLimit = Math.max(1, Math.min(200, limit));
		const items = conversations.slice(start, start + safeLimit);
		return { items, nextCursor: start + items.length < conversations.length ? String(start + items.length) : null };
	}

	async listAllConversations(): Promise<Record<string, ConversationIndex[]>> {
		const result: Record<string, ConversationIndex[]> = {};
		for (const conversation of this.conversations.values()) {
			const bucket = result[conversation.projectId] ?? [];
			bucket.push({ ...conversation });
			result[conversation.projectId] = bucket;
		}
		for (const conversations of Object.values(result))
			conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return result;
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

	async listSkillInstallations(): Promise<SkillInstallationSnapshot[]> {
		return [...this.skillInstallations.values()].map((item) => ({
			...item,
			diagnostics: [...item.diagnostics],
			source: { ...item.source },
		}));
	}

	async saveSkillInstallation(item: SkillInstallationSnapshot): Promise<void> {
		this.skillInstallations.set(item.id, { ...item, diagnostics: [...item.diagnostics], source: { ...item.source } });
	}

	async deleteSkillInstallation(installationId: string): Promise<void> {
		this.skillInstallations.delete(installationId);
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
