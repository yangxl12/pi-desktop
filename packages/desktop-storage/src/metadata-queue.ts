import type { MetadataRepository } from "@earendil-works/pi-desktop-core";
import type {
	AppSettings,
	ConversationIndex,
	McpServerProfile,
	ModelProfile,
	Project,
} from "@earendil-works/pi-desktop-protocol";

/** Serializes access to the synchronous SQLite connection behind async Port calls. */
export class QueuedMetadataRepository implements MetadataRepository {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly inner: MetadataRepository;

	constructor(inner: MetadataRepository) {
		this.inner = inner;
	}

	initialize(): Promise<void> {
		return this.enqueue(() => this.inner.initialize());
	}
	loadSettings(): Promise<AppSettings> {
		return this.enqueue(() => this.inner.loadSettings());
	}
	saveSettings(settings: AppSettings): Promise<void> {
		return this.enqueue(() => this.inner.saveSettings(settings));
	}
	listProjects(): Promise<Project[]> {
		return this.enqueue(() => this.inner.listProjects());
	}
	saveProject(project: Project): Promise<void> {
		return this.enqueue(() => this.inner.saveProject(project));
	}
	deleteProject(projectId: string): Promise<void> {
		return this.enqueue(() => this.inner.deleteProject(projectId));
	}
	listConversations(projectId: string): Promise<ConversationIndex[]> {
		return this.enqueue(() => this.inner.listConversations(projectId));
	}
	listConversationPage(projectId: string, limit: number, cursor?: string) {
		return this.enqueue(async () => {
			if (this.inner.listConversationPage) return this.inner.listConversationPage(projectId, limit, cursor);
			const conversations = await this.inner.listConversations(projectId);
			const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
			const items = conversations.slice(offset, offset + limit);
			return {
				items,
				nextCursor: offset + items.length < conversations.length ? String(offset + items.length) : null,
			};
		});
	}
	listAllConversations(): Promise<Record<string, ConversationIndex[]>> {
		return this.enqueue(async () => {
			if (this.inner.listAllConversations) return this.inner.listAllConversations();
			const projects = await this.inner.listProjects();
			const result: Record<string, ConversationIndex[]> = {};
			for (const project of projects) result[project.id] = await this.inner.listConversations(project.id);
			return result;
		});
	}
	saveConversation(conversation: ConversationIndex): Promise<void> {
		return this.enqueue(() => this.inner.saveConversation(conversation));
	}
	deleteConversation(sessionId: string): Promise<void> {
		return this.enqueue(() => this.inner.deleteConversation(sessionId));
	}
	listModels(): Promise<ModelProfile[]> {
		return this.enqueue(() => this.inner.listModels());
	}
	saveModel(profile: ModelProfile): Promise<void> {
		return this.enqueue(() => this.inner.saveModel(profile));
	}
	deleteModel(profileId: string): Promise<void> {
		return this.enqueue(() => this.inner.deleteModel(profileId));
	}
	listMcpServers(): Promise<McpServerProfile[]> {
		return this.enqueue(() => this.inner.listMcpServers());
	}
	saveMcpServer(profile: McpServerProfile): Promise<void> {
		return this.enqueue(() => this.inner.saveMcpServer(profile));
	}
	deleteMcpServer(serverId: string): Promise<void> {
		return this.enqueue(() => this.inner.deleteMcpServer(serverId));
	}
	close(): Promise<void> {
		return this.enqueue(() => this.inner.close());
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const next = this.tail.then(task, task);
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}
}
