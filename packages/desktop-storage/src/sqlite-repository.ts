import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MetadataRepository } from "@earendil-works/pi-desktop-core";
import { DEFAULT_APP_SETTINGS } from "@earendil-works/pi-desktop-core";
import type {
	AppSettings,
	ConversationIndex,
	McpServerProfile,
	ModelProfile,
	Project,
} from "@earendil-works/pi-desktop-protocol";

interface ProjectRow {
	id: string;
	name: string;
	root_path: string;
	trust_state: Project["trustState"];
	created_at: string;
	updated_at: string;
	last_opened_at: string | null;
}

interface ConversationRow {
	id: string;
	project_id: string;
	session_path: string;
	runtime_provider_id: string | null;
	runtime_session_ref: string | null;
	session_codec_id: string | null;
	session_format_version: number | null;
	history_access: ConversationIndex["historyAccess"] | null;
	title: string;
	created_at: string;
	updated_at: string;
	model_provider: string | null;
	model_id: string | null;
	thinking_level: ConversationIndex["thinkingLevel"];
	leaf_id: string | null;
	status: ConversationIndex["status"];
}

interface ModelRow {
	id: string;
	provider_id: string;
	display_name: string;
	base_url: string;
	model_id: string;
	credential_ref: string | null;
	protocol: ModelProfile["protocol"] | null;
	capabilities_json: string | null;
	credential_strategy: ModelProfile["credentialStrategy"] | null;
	enabled: number;
	created_at: string;
	updated_at: string;
}

interface McpServerRow {
	id: string;
	value_json: string;
}

function projectFromRow(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		rootPath: row.root_path,
		trustState: row.trust_state,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastOpenedAt: row.last_opened_at,
	};
}

function conversationFromRow(row: ConversationRow): ConversationIndex {
	return {
		id: row.id,
		projectId: row.project_id,
		sessionPath: row.session_path,
		runtimeProviderId: row.runtime_provider_id ?? "pi",
		runtimeSessionRef: row.runtime_session_ref ?? row.session_path,
		sessionCodecId: row.session_codec_id ?? "pi-jsonl",
		sessionFormatVersion: row.session_format_version,
		historyAccess: row.history_access ?? "continue",
		title: row.title,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		modelProvider: row.model_provider,
		modelId: row.model_id,
		thinkingLevel: row.thinking_level,
		leafId: row.leaf_id,
		status: row.status,
	};
}

function modelFromRow(row: ModelRow): ModelProfile {
	return {
		id: row.id,
		providerId: row.provider_id,
		displayName: row.display_name,
		baseUrl: row.base_url,
		modelId: row.model_id,
		credentialRef: row.credential_ref,
		protocol: row.protocol ?? undefined,
		capabilities: row.capabilities_json
			? (JSON.parse(row.capabilities_json) as ModelProfile["capabilities"])
			: undefined,
		credentialStrategy: row.credential_strategy ?? undefined,
		enabled: row.enabled === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SqliteMetadataRepository implements MetadataRepository {
	private readonly database: DatabaseSync;
	private closed = false;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.database = new DatabaseSync(path);
	}

	async initialize(): Promise<void> {
		this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database.exec(`
				CREATE TABLE IF NOT EXISTS schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS projects (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					root_path TEXT NOT NULL UNIQUE,
					trust_state TEXT NOT NULL CHECK (trust_state IN ('unknown', 'trusted', 'untrusted')),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					last_opened_at TEXT
				);
				CREATE TABLE IF NOT EXISTS conversations (
					id TEXT PRIMARY KEY,
					project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
					session_path TEXT NOT NULL UNIQUE,
					runtime_provider_id TEXT,
					runtime_session_ref TEXT,
					session_codec_id TEXT,
					session_format_version INTEGER,
					history_access TEXT,
					title TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					model_provider TEXT,
					model_id TEXT,
					thinking_level TEXT NOT NULL,
					leaf_id TEXT,
					status TEXT NOT NULL
				);
				CREATE INDEX IF NOT EXISTS conversations_project_updated
					ON conversations(project_id, updated_at DESC);
				CREATE TABLE IF NOT EXISTS model_profiles (
					id TEXT PRIMARY KEY,
					provider_id TEXT NOT NULL,
					display_name TEXT NOT NULL,
					base_url TEXT NOT NULL,
					model_id TEXT NOT NULL,
					credential_ref TEXT,
					protocol TEXT,
					capabilities_json TEXT,
					credential_strategy TEXT,
					enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					UNIQUE(provider_id, model_id)
				);
				CREATE TABLE IF NOT EXISTS app_settings (
					id INTEGER PRIMARY KEY CHECK (id = 1),
					value_json TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS mcp_servers (
					id TEXT PRIMARY KEY,
					value_json TEXT NOT NULL
				);
			`);
			const conversationColumns = new Set(
				(this.database.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>).map(
					(column) => column.name,
				),
			);
			for (const [name, definition] of [
				["runtime_provider_id", "TEXT"],
				["runtime_session_ref", "TEXT"],
				["session_codec_id", "TEXT"],
				["session_format_version", "INTEGER"],
				["history_access", "TEXT"],
			] as const) {
				if (!conversationColumns.has(name))
					this.database.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${definition}`);
			}
			const modelColumns = new Set(
				(this.database.prepare("PRAGMA table_info(model_profiles)").all() as Array<{ name: string }>).map(
					(column) => column.name,
				),
			);
			for (const [name, definition] of [
				["protocol", "TEXT"],
				["capabilities_json", "TEXT"],
				["credential_strategy", "TEXT"],
			] as const) {
				if (!modelColumns.has(name))
					this.database.exec(`ALTER TABLE model_profiles ADD COLUMN ${name} ${definition}`);
			}
			this.database
				.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(1, new Date().toISOString());
			this.database
				.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(2, new Date().toISOString());
			this.database
				.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
				.run(3, new Date().toISOString());
			this.database.exec("COMMIT");
		} catch (error: unknown) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	async loadSettings(): Promise<AppSettings> {
		const row = this.database.prepare("SELECT value_json FROM app_settings WHERE id = 1").get() as
			| { value_json: string }
			| undefined;
		if (!row) return { ...DEFAULT_APP_SETTINGS, skillDirectories: [] };
		const parsed = JSON.parse(row.value_json) as Partial<AppSettings>;
		return {
			...DEFAULT_APP_SETTINGS,
			...parsed,
			skillDirectories: Array.isArray(parsed.skillDirectories) ? [...parsed.skillDirectories] : [],
		};
	}

	async saveSettings(settings: AppSettings): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO app_settings(id, value_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json",
			)
			.run(JSON.stringify(settings));
	}

	async listProjects(): Promise<Project[]> {
		return (
			this.database.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as unknown as ProjectRow[]
		).map(projectFromRow);
	}

	async saveProject(project: Project): Promise<void> {
		this.database
			.prepare(`
				INSERT INTO projects(id, name, root_path, trust_state, created_at, updated_at, last_opened_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					root_path = excluded.root_path,
					trust_state = excluded.trust_state,
					updated_at = excluded.updated_at,
					last_opened_at = excluded.last_opened_at
			`)
			.run(
				project.id,
				project.name,
				project.rootPath,
				project.trustState,
				project.createdAt,
				project.updatedAt,
				project.lastOpenedAt,
			);
	}

	async deleteProject(projectId: string): Promise<void> {
		this.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
	}

	async listConversations(projectId: string): Promise<ConversationIndex[]> {
		return (
			this.database
				.prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC")
				.all(projectId) as unknown as ConversationRow[]
		).map(conversationFromRow);
	}

	async listConversationPage(projectId: string, limit: number, cursor?: string) {
		const safeLimit = Math.max(1, Math.min(200, limit));
		const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
		const rows = this.database
			.prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?")
			.all(projectId, safeLimit, offset) as unknown as ConversationRow[];
		const items = rows.map(conversationFromRow);
		const total = Number(
			(
				this.database
					.prepare("SELECT COUNT(*) AS count FROM conversations WHERE project_id = ?")
					.get(projectId) as { count: number }
			).count,
		);
		return { items, nextCursor: offset + items.length < total ? String(offset + items.length) : null };
	}

	async listAllConversations(): Promise<Record<string, ConversationIndex[]>> {
		const rows = this.database
			.prepare("SELECT * FROM conversations ORDER BY project_id, updated_at DESC")
			.all() as unknown as ConversationRow[];
		const result: Record<string, ConversationIndex[]> = {};
		for (const row of rows) {
			const bucket = result[row.project_id] ?? [];
			bucket.push(conversationFromRow(row));
			result[row.project_id] = bucket;
		}
		return result;
	}

	async saveConversation(conversation: ConversationIndex): Promise<void> {
		this.database
			.prepare(`
				INSERT INTO conversations(
					id, project_id, session_path, runtime_provider_id, runtime_session_ref, session_codec_id,
					session_format_version, history_access, title, created_at, updated_at,
					model_provider, model_id, thinking_level, leaf_id, status
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					session_path = excluded.session_path,
					runtime_provider_id = excluded.runtime_provider_id,
					runtime_session_ref = excluded.runtime_session_ref,
					session_codec_id = excluded.session_codec_id,
					session_format_version = excluded.session_format_version,
					history_access = excluded.history_access,
					title = excluded.title,
					updated_at = excluded.updated_at,
					model_provider = excluded.model_provider,
					model_id = excluded.model_id,
					thinking_level = excluded.thinking_level,
					leaf_id = excluded.leaf_id,
					status = excluded.status
			`)
			.run(
				conversation.id,
				conversation.projectId,
				conversation.sessionPath,
				conversation.runtimeProviderId ?? "pi",
				conversation.runtimeSessionRef ?? conversation.sessionPath,
				conversation.sessionCodecId ?? "pi-jsonl",
				conversation.sessionFormatVersion ?? 3,
				conversation.historyAccess ?? "continue",
				conversation.title,
				conversation.createdAt,
				conversation.updatedAt,
				conversation.modelProvider,
				conversation.modelId,
				conversation.thinkingLevel,
				conversation.leafId,
				conversation.status,
			);
	}

	async deleteConversation(sessionId: string): Promise<void> {
		this.database.prepare("DELETE FROM conversations WHERE id = ?").run(sessionId);
	}

	async listModels(): Promise<ModelProfile[]> {
		return (
			this.database.prepare("SELECT * FROM model_profiles ORDER BY updated_at DESC").all() as unknown as ModelRow[]
		).map(modelFromRow);
	}

	async saveModel(profile: ModelProfile): Promise<void> {
		this.database
			.prepare(`
				INSERT INTO model_profiles(
					id, provider_id, display_name, base_url, model_id, credential_ref, protocol, capabilities_json,
					credential_strategy, enabled, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					provider_id = excluded.provider_id,
					display_name = excluded.display_name,
					base_url = excluded.base_url,
					model_id = excluded.model_id,
					credential_ref = excluded.credential_ref,
					protocol = excluded.protocol,
					capabilities_json = excluded.capabilities_json,
					credential_strategy = excluded.credential_strategy,
					enabled = excluded.enabled,
					updated_at = excluded.updated_at
			`)
			.run(
				profile.id,
				profile.providerId,
				profile.displayName,
				profile.baseUrl,
				profile.modelId,
				profile.credentialRef,
				profile.protocol ?? null,
				profile.capabilities ? JSON.stringify(profile.capabilities) : null,
				profile.credentialStrategy ?? null,
				profile.enabled ? 1 : 0,
				profile.createdAt,
				profile.updatedAt,
			);
	}

	async deleteModel(profileId: string): Promise<void> {
		this.database.prepare("DELETE FROM model_profiles WHERE id = ?").run(profileId);
	}

	async listMcpServers(): Promise<McpServerProfile[]> {
		return (
			this.database.prepare("SELECT id, value_json FROM mcp_servers ORDER BY id").all() as unknown as McpServerRow[]
		).map((row) => JSON.parse(row.value_json) as McpServerProfile);
	}

	async saveMcpServer(profile: McpServerProfile): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO mcp_servers(id, value_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json",
			)
			.run(profile.id, JSON.stringify(profile));
	}

	async deleteMcpServer(serverId: string): Promise<void> {
		this.database.prepare("DELETE FROM mcp_servers WHERE id = ?").run(serverId);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.database.close();
	}
}
