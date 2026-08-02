import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
	AppSettings,
	ConversationIndex,
	DesktopCommand,
	DesktopEvent,
	DesktopMessage,
	DesktopResponse,
	DesktopState,
	Diagnostic,
	McpConsentRequest,
	McpServerDraft,
	McpServerPatch,
	McpServerProfile,
	McpServerSnapshot,
	MessagePart,
	ModelConnectionResult,
	ModelProfile,
	ModelProfileDraft,
	ModelProfilePatch,
	Project,
	RuntimeSnapshot,
	SkillCommand,
	ThinkingLevel,
	TrustState,
} from "@earendil-works/pi-desktop-protocol";
import { DesktopError, toDesktopError } from "@earendil-works/pi-desktop-protocol";
import { DEFAULT_APP_SETTINGS } from "./memory-repository.ts";
import { normalizeModelBaseUrl } from "./models.ts";
import { canonicalizeProjectPath, canonicalizeResourcePath, projectName } from "./paths.ts";
import type {
	AgentEvent,
	AgentRuntimePort,
	DesktopHostPorts,
	DesktopLogger,
	McpPort,
	McpPortEvent,
	MetadataRepository,
	ModelConnectionTester,
	RuntimeModel,
	SecretStore,
	SessionFileRepository,
	SessionFileSummary,
} from "./ports.ts";
import { defaultInvokeShortcut, normalizeShortcut } from "./shortcuts.ts";

interface ApplicationOptions {
	platform: "win32" | "darwin" | "linux";
	ports: DesktopHostPorts;
	/** Compatibility injection for the default runtime. */
	pi?: AgentRuntimePort;
	/** Provider-aware runtime facade introduced in phase 4. */
	runtimeService?: AgentRuntimePort;
	runtimeProviderId?: string;
	metadata: MetadataRepository;
	secrets?: SecretStore;
	sessionFiles?: SessionFileRepository;
	modelConnection?: ModelConnectionTester;
	mcp?: McpPort;
	logger?: DesktopLogger;
	agentDirectory?: string;
	sessionDirectory?: (project: Project) => string;
	webSearchExtensionPath?: string;
}

function now(): string {
	return new Date().toISOString();
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);
}

function isAppTheme(value: unknown): value is AppSettings["theme"] {
	return value === "light" || value === "dark";
}

function isFontSize(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function cloneMessage(message: DesktopMessage): DesktopMessage {
	return { ...message, parts: message.parts.map((part) => ({ ...part })) };
}

function mergePartText(current: string, incoming: string, separator = "\n\n"): string {
	if (!current) return incoming;
	if (!incoming || current === incoming || current.includes(incoming)) return current;
	if (incoming.includes(current)) return incoming;
	return `${current}${separator}${incoming}`;
}

function mergeMessageParts(target: DesktopMessage, incoming: DesktopMessage): MessagePart[] {
	const parts = target.parts.map((part) => ({ ...part }));
	for (const incomingPart of incoming.parts) {
		const existing =
			incomingPart.type === "tool"
				? parts.find(
						(part) =>
							part.type === "tool" &&
							part.toolCallId !== undefined &&
							part.toolCallId === incomingPart.toolCallId,
					)
				: parts.find((part) => part.type === incomingPart.type);
		if (!existing) {
			parts.push({ ...incomingPart });
			continue;
		}
		if (existing.type === "tool" && incomingPart.type === "tool") {
			if (incomingPart.text.length >= existing.text.length) existing.text = incomingPart.text;
			if (incomingPart.toolName) existing.toolName = incomingPart.toolName;
			if (incomingPart.status) existing.status = incomingPart.status;
		} else {
			existing.text = mergePartText(existing.text, incomingPart.text);
		}
	}
	return parts;
}

function collapseMessages(messages: DesktopMessage[]): DesktopMessage[] {
	const result: DesktopMessage[] = [];
	for (const message of messages) {
		if (message.role === "user" || message.role === "system") {
			result.push(cloneMessage(message));
			continue;
		}
		const previous = result.at(-1);
		if (message.role === "tool") {
			if (previous?.role === "assistant") previous.parts = mergeMessageParts(previous, message);
			continue;
		}
		if (message.role !== "assistant") continue;
		if (previous?.role === "assistant") {
			previous.parts = mergeMessageParts(previous, message);
			previous.status = message.status ?? previous.status;
			if (message.durationMs !== undefined) previous.durationMs = message.durationMs;
			continue;
		}
		result.push(cloneMessage(message));
	}
	return result;
}

function messageFingerprint(message: DesktopMessage): string {
	return message.parts.map((part) => `${part.type}:${part.toolCallId ?? ""}:${part.text}`).join("\u0001");
}

function hasVisibleMessageContent(message: DesktopMessage): boolean {
	return message.parts.some((part) => part.text.trim().length > 0);
}

function truncateTitle(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function asRuntimeSnapshot(
	projectId: string,
	sessionId: string,
	runtimeId: string,
	state: { status: RuntimeSnapshot["status"] } & Omit<Partial<RuntimeSnapshot>, "sessionId"> & {
			sessionId?: string | null;
			sessionRef?: string | null;
		},
): RuntimeSnapshot {
	return {
		projectId,
		sessionId,
		runtimeId,
		status: state.status,
		isStreaming: state.isStreaming ?? false,
		thinkingLevel: state.thinkingLevel ?? "high",
		modelProvider: state.modelProvider ?? null,
		modelId: state.modelId ?? null,
		sessionPath: state.sessionPath ?? null,
		runtimeSessionRef: state.sessionRef ?? state.sessionPath ?? null,
		...(state.providerId ? { providerId: state.providerId } : {}),
		...(state.capabilities ? { capabilities: state.capabilities } : {}),
		messageCount: state.messageCount ?? 0,
		lastError: state.lastError ?? null,
	};
}

function conversationFromSummary(
	projectId: string,
	summary: SessionFileSummary,
	existing?: ConversationIndex,
): ConversationIndex {
	return {
		id: existing?.id ?? summary.id,
		projectId,
		sessionPath: summary.sessionPath,
		runtimeProviderId: existing?.runtimeProviderId ?? summary.runtimeProviderId ?? "pi",
		runtimeSessionRef: existing?.runtimeSessionRef ?? summary.runtimeSessionRef ?? summary.sessionPath,
		sessionCodecId: existing?.sessionCodecId ?? summary.sessionCodecId ?? "pi-jsonl",
		sessionFormatVersion: existing?.sessionFormatVersion ?? summary.sessionFormatVersion ?? 3,
		historyAccess: summary.historyAccess ?? "continue",
		title: summary.title,
		createdAt: existing?.createdAt ?? summary.createdAt,
		updatedAt: summary.updatedAt,
		modelProvider: summary.modelProvider,
		modelId: summary.modelId,
		thinkingLevel: summary.thinkingLevel,
		leafId: summary.leafId,
		status: existing?.status === "error" ? "error" : "idle",
	};
}

function publicMcpSnapshot(snapshot: McpServerSnapshot): McpServerSnapshot {
	return {
		...snapshot,
		profile: {
			...snapshot.profile,
			args: [...snapshot.profile.args],
			env: Object.fromEntries(Object.keys(snapshot.profile.env).map((key) => [key, "[redacted]"])),
		},
	};
}

export class DesktopApplication {
	private readonly options: ApplicationOptions;
	private readonly listeners = new Set<(event: DesktopEvent) => void>();
	private readonly diagnostics: Diagnostic[] = [];
	private readonly messages = new Map<string, DesktopMessage>();
	private streamingAssistantMessageId: string | undefined;
	private readonly assistantStartedAt = new Map<string, number>();
	private settings: AppSettings = {
		...DEFAULT_APP_SETTINGS,
		skillDirectories: [],
		webSearch: { ...DEFAULT_APP_SETTINGS.webSearch },
	};
	private projects: Project[] = [];
	private conversations: ConversationIndex[] = [];
	private models: ModelProfile[] = [];
	private mcpServers: McpServerSnapshot[] = [];
	private mcpProfiles: McpServerProfile[] = [];
	private consentRequests: McpConsentRequest[] = [];
	private commands: SkillCommand[] = [];
	private activeProjectId: string | null = null;
	private activeSessionId: string | null = null;
	private draftSession: ConversationIndex | null = null;
	private draftPromotion: Promise<void> | undefined;
	private runtime: RuntimeSnapshot | null = null;
	private readonly runtimePort: AgentRuntimePort;
	private piUnsubscribe: (() => void) | undefined;
	private mcpUnsubscribe: (() => void) | undefined;
	private registeredShortcut: string | undefined;
	private initialized = false;

	constructor(options: ApplicationOptions) {
		this.options = options;
		const runtimePort = options.runtimeService ?? options.pi;
		if (!runtimePort) throw new Error("A runtime port is required");
		this.runtimePort = runtimePort;
		this.piUnsubscribe = this.runtimePort.subscribe((event) => this.handleAgentEvent(event));
		this.mcpUnsubscribe = options.mcp?.subscribe((event) => this.handleMcpEvent(event));
	}

	subscribe(listener: (event: DesktopEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async initialize(): Promise<DesktopState> {
		if (this.initialized) return this.getState();
		await this.options.metadata.initialize();
		const savedSettings = await this.options.metadata.loadSettings();
		this.settings = {
			...DEFAULT_APP_SETTINGS,
			...savedSettings,
			skillDirectories: [...(savedSettings.skillDirectories ?? [])],
			webSearch: { ...DEFAULT_APP_SETTINGS.webSearch, ...(savedSettings.webSearch ?? {}) },
		};
		if (!isThinkingLevel(this.settings.defaultThinkingLevel)) this.settings.defaultThinkingLevel = "high";
		if (!isAppTheme(this.settings.theme)) this.settings.theme = "dark";
		if (!isFontSize(this.settings.conversationFontSize, 14, 20)) this.settings.conversationFontSize = 16;
		if (!isFontSize(this.settings.sidebarFontSize, 12, 18)) this.settings.sidebarFontSize = 14;
		if (
			this.options.platform === "win32" &&
			this.settings.schemaVersion < DEFAULT_APP_SETTINGS.schemaVersion &&
			this.settings.invokeShortcut === "Ctrl+Shift+0"
		) {
			this.settings.invokeShortcut = defaultInvokeShortcut(this.options.platform);
		}
		this.settings.schemaVersion = DEFAULT_APP_SETTINGS.schemaVersion;
		if (!this.settings.invokeShortcut) this.settings.invokeShortcut = defaultInvokeShortcut(this.options.platform);
		await this.options.ports.window.setCloseToTray(this.settings.closeToTray);
		this.projects = await this.options.metadata.listProjects();
		this.models = await this.options.metadata.listModels();
		const firstEnabledModel = this.models.find((model) => model.enabled);
		if (!this.models.some((model) => model.id === this.settings.defaultModelProfileId && model.enabled))
			this.settings.defaultModelProfileId = firstEnabledModel?.id ?? null;
		await this.options.metadata.saveSettings(this.settings);
		this.mcpProfiles = await this.options.metadata.listMcpServers();
		this.options.mcp?.setProfiles(this.mcpProfiles);
		this.mcpServers = this.options.mcp?.list() ?? [];
		await this.options.ports.tray.create({
			open: () => void this.showWindow(),
			settings: () => void this.showWindow(),
			quit: () => void this.quit(),
		});
		await this.registerShortcut(this.settings.invokeShortcut);
		this.initialized = true;
		const lastProject = this.projects[0];
		if (lastProject) {
			try {
				await this.selectProject(lastProject.id);
			} catch (error: unknown) {
				this.recordDiagnostic("warning", "startup", toDesktopError(error).message);
			}
		}
		await this.reconcileMcp();
		return this.getState();
	}

	async dispatch(command: DesktopCommand, requestId: string = randomUUID()): Promise<DesktopResponse> {
		try {
			const data = await this.execute(command);
			return { requestId, success: true, data };
		} catch (error: unknown) {
			const desktopError = toDesktopError(error);
			this.recordDiagnostic("error", "application", desktopError.message, requestId);
			return { requestId, success: false, error: desktopError.toJSON() };
		}
	}

	getState(): DesktopState {
		return {
			platform: this.options.platform,
			window: this.options.ports.window.getState(),
			projects: this.projects.map((project) => ({ ...project })),
			activeProjectId: this.activeProjectId,
			conversations: this.conversations.map((conversation) => ({ ...conversation })),
			activeSessionId: this.activeSessionId,
			runtime: this.runtime ? { ...this.runtime } : null,
			messages: collapseMessages([...this.messages.values()]),
			models: this.models.map((model) => ({ ...model })),
			commands: this.commands.map((command) => ({ ...command })),
			mcpServers: this.mcpServers.map((server) => ({
				...server,
				profile: { ...server.profile, args: [...server.profile.args], env: { ...server.profile.env } },
			})),
			mcpTools: this.options.mcp?.listTools(this.activeProjectId ?? undefined) ?? [],
			consentRequests: this.consentRequests.map((request) => ({ ...request })),
			settings: { ...this.settings, skillDirectories: [...this.settings.skillDirectories] },
			diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
		};
	}

	private async execute(command: DesktopCommand): Promise<unknown> {
		switch (command.type) {
			case "window.show":
				return this.showWindow();
			case "window.hide":
				return this.options.ports.window.hide();
			case "window.toggle":
				return this.options.ports.window.toggle();
			case "window.minimize":
				return this.options.ports.window.minimize();
			case "window.maximize":
				return this.options.ports.window.maximize();
			case "window.closeToTray":
				return this.closeToTray();
			case "app.quit":
				return this.quit();
			case "app.getState":
				return this.getState();
			case "app.getDiagnostics":
				return this.diagnostics;
			case "app.exportDiagnostics":
				if (!this.options.ports.diagnosticsExport)
					throw new DesktopError("NOT_SUPPORTED", "Diagnostic export is unavailable");
				return this.options.ports.diagnosticsExport(this.diagnostics);
			case "projects.list":
				return this.projects;
			case "projects.addFromFolder":
				return this.addProject(await this.requireFolderPicker().selectProjectFolder());
			case "projects.add":
				return this.addProject(command.rootPath, command.name);
			case "projects.select":
				return this.selectProject(command.projectId);
			case "projects.rename":
				return this.renameProject(command.projectId, command.name);
			case "projects.setTrust":
				return this.setProjectTrust(command.projectId, command.trustState);
			case "projects.remove":
				return this.removeProject(command.projectId);
			case "sessions.list":
				return this.options.metadata.listConversations(command.projectId);
			case "sessions.create":
				return this.createSession(command.projectId, command.title);
			case "sessions.open":
				return this.openSession(command.sessionId);
			case "sessions.rename":
				return this.renameSession(command.sessionId, command.title);
			case "sessions.refresh":
				return this.refreshSession(command.sessionId);
			case "sessions.rebuild":
				return this.rebuildSessions(command.projectId);
			case "agent.getState":
				return this.requireRuntimeState();
			case "agent.getMessages":
				return collapseMessages([...this.messages.values()]);
			case "agent.prompt":
				return this.prompt(command.text, command.queueMode ?? "prompt");
			case "agent.retryLast":
				return this.retryLast();
			case "agent.abort":
				return this.abort();
			case "agent.setThinkingLevel":
				return this.setThinkingLevel(command.level);
			case "agent.setModel":
				return this.setModel(command.profileId);
			case "agent.getCommands":
				return { commands: await this.requireRuntime().getCommands() };
			case "settings.get":
				return this.settings;
			case "settings.update":
				return this.updateSettings(command.patch);
			case "settings.reset":
				return this.resetSetting(command.key);
			case "webSearch.update":
				return this.updateWebSearch(command.provider, command.apiKey, command.clearCredential);
			case "models.list":
				return this.models;
			case "models.create":
				return this.createModel(command.profile, command.apiKey);
			case "models.update":
				return this.updateModel(command.profileId, command.patch, command.apiKey, command.clearCredential);
			case "models.delete":
				return this.deleteModel(command.profileId);
			case "models.testConnection":
				return this.testModelConnection(command.profileId);
			case "models.setDefault":
				return this.setDefaultModel(command.profileId);
			case "skills.list":
				return this.commands.filter((command) => command.source === "skill");
			case "skills.reload":
				return this.reloadSkills();
			case "mcp.list":
				return this.mcpServers;
			case "mcp.create":
				return this.createMcpServer(command.profile);
			case "mcp.update":
				return this.updateMcpServer(command.serverId, command.patch);
			case "mcp.delete":
				return this.deleteMcpServer(command.serverId);
			case "mcp.setEnabled":
				return this.setMcpEnabled(command.serverId, command.enabled);
			case "mcp.testConnection":
				return this.testMcpConnection(command.serverId);
			case "mcp.listTools":
				return this.options.mcp?.listTools(command.projectId ?? this.activeProjectId ?? undefined) ?? [];
			case "mcp.consent.respond":
				if (!this.options.mcp?.respondConsent?.(command.requestId, command.approved, command.scope))
					throw new DesktopError("NOT_FOUND", "Consent request is no longer pending", {
						requestId: command.requestId,
					});
				return true;
		}
	}

	private async showWindow(): Promise<void> {
		await this.options.ports.window.show();
		this.emit({ type: "window.changed", ...this.options.ports.window.getState() });
	}

	private async closeToTray(): Promise<void> {
		await this.options.ports.window.hide();
		this.emit({ type: "window.changed", ...this.options.ports.window.getState() });
	}

	private async quit(): Promise<void> {
		await this.options.mcp?.stopAll("application quit");
		this.options.mcp?.dispose?.();
		await this.stopRuntime("application quit");
		await this.options.ports.shortcut.unregister(this.registeredShortcut ?? this.settings.invokeShortcut);
		await this.options.ports.tray.destroy();
		await this.options.ports.singleInstance.release();
		await this.options.ports.window.close();
		await this.options.metadata.close();
	}

	private async registerShortcut(shortcut: string): Promise<void> {
		const normalized = normalizeShortcut(shortcut, this.options.platform);
		const previous = this.registeredShortcut;
		try {
			if (previous) await this.options.ports.shortcut.unregister(previous);
			await this.options.ports.shortcut.register(normalized, () => void this.options.ports.window.toggle());
			this.registeredShortcut = normalized;
		} catch (error: unknown) {
			if (previous) {
				try {
					await this.options.ports.shortcut.register(previous, () => void this.options.ports.window.toggle());
				} catch {
					// Preserve the original registration error.
				}
			}
			throw new DesktopError("CONFLICT", "Global shortcut registration failed", {
				cause: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async addProject(rootPath: string | null | undefined, requestedName?: string): Promise<Project> {
		if (!rootPath) throw new DesktopError("INVALID_ARGUMENT", "Project folder selection was cancelled");
		const canonicalPath = await canonicalizeProjectPath(rootPath);
		const existing = this.projects.find((project) => project.rootPath.toLowerCase() === canonicalPath.toLowerCase());
		if (existing) {
			await this.selectProject(existing.id);
			return existing;
		}
		const timestamp = now();
		const project: Project = {
			id: randomUUID(),
			name: requestedName?.trim() || projectName(canonicalPath),
			rootPath: canonicalPath,
			trustState: "unknown",
			createdAt: timestamp,
			updatedAt: timestamp,
			lastOpenedAt: timestamp,
		};
		await this.options.metadata.saveProject(project);
		this.projects = await this.options.metadata.listProjects();
		await this.selectProject(project.id);
		return project;
	}

	private async selectProject(projectId: string): Promise<Project> {
		const project = this.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new DesktopError("NOT_FOUND", "Project not found", { projectId });
		if (this.activeProjectId === project.id && this.runtime) return project;
		await this.stopRuntime("project changed");
		this.activeProjectId = project.id;
		this.activeSessionId = null;
		this.draftSession = null;
		project.lastOpenedAt = now();
		project.updatedAt = project.lastOpenedAt;
		await this.options.metadata.saveProject(project);
		this.projects = await this.options.metadata.listProjects();
		this.conversations = await this.loadProjectConversations(project);
		const session = this.conversations[0];
		if (session) await this.openSession(session.id);
		else await this.createSession(project.id);
		await this.reconcileMcp();
		return project;
	}

	private async renameProject(projectId: string, name: string): Promise<Project> {
		const project = this.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new DesktopError("NOT_FOUND", "Project not found", { projectId });
		const nextName = name.trim();
		if (!nextName) throw new DesktopError("INVALID_ARGUMENT", "Project name cannot be empty");
		const updated = { ...project, name: nextName, updatedAt: now() };
		await this.options.metadata.saveProject(updated);
		this.projects = await this.options.metadata.listProjects();
		return updated;
	}

	private async setProjectTrust(projectId: string, trustState: TrustState): Promise<Project> {
		const project = this.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new DesktopError("NOT_FOUND", "Project not found", { projectId });
		const updated = { ...project, trustState, updatedAt: now() };
		await this.options.metadata.saveProject(updated);
		this.projects = await this.options.metadata.listProjects();
		if (projectId === this.activeProjectId) await this.restartActiveRuntime("project trust changed");
		return updated;
	}

	private async removeProject(projectId: string): Promise<null> {
		if (!this.projects.some((project) => project.id === projectId))
			throw new DesktopError("NOT_FOUND", "Project not found", { projectId });
		if (this.activeProjectId === projectId) {
			await this.stopRuntime("project removed");
			this.activeProjectId = null;
			this.activeSessionId = null;
			this.draftSession = null;
			this.conversations = [];
			this.messages.clear();
		}
		await this.options.metadata.deleteProject(projectId);
		this.projects = await this.options.metadata.listProjects();
		return null;
	}

	private async createSession(projectId: string, title = "New conversation"): Promise<ConversationIndex> {
		const project = this.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new DesktopError("NOT_FOUND", "Project not found", { projectId });
		if (this.activeProjectId !== projectId) await this.selectProject(projectId);
		if (
			this.draftSession?.id === this.activeSessionId &&
			!this.runtime?.isStreaming &&
			[...this.messages.values()].some(
				(message) => message.role === "assistant" && hasVisibleMessageContent(message),
			)
		)
			await this.promoteDraftSession();
		if (this.runtime?.projectId === projectId) {
			if (this.runtime.isStreaming) await this.abort();
			await this.requireRuntime().newSession();
			const defaultProfile = this.models.find(
				(model) => model.id === this.settings.defaultModelProfileId && model.enabled,
			);
			if (defaultProfile) await this.requireRuntime().setModel(defaultProfile.providerId, defaultProfile.modelId);
			await this.requireRuntime().setThinkingLevel(this.settings.defaultThinkingLevel);
			const state = await this.requireRuntime().getState();
			this.messages.clear();
			const session = this.buildSessionIndex(project, state, title);
			this.draftSession = session;
			this.activeSessionId = session.id;
			this.runtime = asRuntimeSnapshot(project.id, session.id, this.runtime.runtimeId, {
				status: "ready",
				...state,
			});
			if (session.title !== "New conversation") await this.requireRuntime().setSessionName(session.title);
			await this.refreshRuntimeMessages();
			this.emit({ type: "session.changed", ...this.runtime, sessionId: session.id, projectId });
			return session;
		}
		await this.startRuntime(project);
		const state = await this.requireRuntime().getState();
		const session = this.buildSessionIndex(project, state, title);
		this.draftSession = session;
		this.activeSessionId = session.id;
		if (this.runtime) {
			this.runtime = { ...this.runtime, sessionId: session.id, sessionPath: session.sessionPath };
		}
		if (session.title !== "New conversation") await this.requireRuntime().setSessionName(session.title);
		return session;
	}

	private buildSessionIndex(
		project: Project,
		state: {
			sessionPath?: string | null;
			sessionRef?: string | null;
			thinkingLevel: ThinkingLevel;
			modelProvider: string | null;
			modelId: string | null;
		},
		title: string,
	): ConversationIndex {
		const sessionPath = state.sessionPath ?? state.sessionRef;
		if (!sessionPath) throw new DesktopError("PROCESS_ERROR", "Runtime did not create a session reference");
		const timestamp = now();
		return {
			id: randomUUID(),
			projectId: project.id,
			sessionPath,
			title: title.trim() || "New conversation",
			createdAt: timestamp,
			updatedAt: timestamp,
			modelProvider: state.modelProvider,
			modelId: state.modelId,
			thinkingLevel: state.thinkingLevel,
			leafId: null,
			status: "idle",
		};
	}

	private async openSession(sessionId: string): Promise<ConversationIndex> {
		const session = await this.findSession(sessionId);
		if (!session) throw new DesktopError("NOT_FOUND", "Session not found", { sessionId });
		const project = this.projects.find((candidate) => candidate.id === session.projectId);
		if (!project) throw new DesktopError("NOT_FOUND", "Project not found", { projectId: session.projectId });
		if (this.options.sessionFiles && !(await this.options.sessionFiles.exists(session.sessionPath))) {
			throw new DesktopError("NOT_FOUND", "Session file is missing", { sessionPath: session.sessionPath });
		}
		if (this.runtime?.projectId === project.id) {
			if (this.activeSessionId === session.id) return session;
			if (this.runtime.isStreaming) await this.abort();
			await this.requireRuntime().switchSession(session.sessionPath);
			this.draftSession = null;
			this.activeSessionId = session.id;
			this.messages.clear();
			const state = await this.requireRuntime().getState();
			this.runtime = asRuntimeSnapshot(project.id, session.id, this.runtime.runtimeId, {
				status: "ready",
				...state,
			});
			await this.refreshRuntimeMessages();
			await this.refreshCommands();
			this.emit({ type: "session.changed", ...this.runtime, sessionId: session.id, projectId: project.id });
			return session;
		}
		await this.stopRuntime("session changed");
		this.activeProjectId = project.id;
		this.draftSession = null;
		this.activeSessionId = session.id;
		await this.startRuntime(project, session);
		return session;
	}

	private async renameSession(sessionId: string, title: string): Promise<ConversationIndex> {
		const session = await this.findSession(sessionId);
		if (!session) throw new DesktopError("NOT_FOUND", "Session not found", { sessionId });
		const nextTitle = title.trim();
		if (!nextTitle) throw new DesktopError("INVALID_ARGUMENT", "Session title cannot be empty");
		const updated = { ...session, title: nextTitle, updatedAt: now() };
		await this.options.metadata.saveConversation(updated);
		if (sessionId === this.activeSessionId) await this.requireRuntime().setSessionName(nextTitle);
		this.conversations = await this.options.metadata.listConversations(updated.projectId);
		return updated;
	}

	private async refreshSession(sessionId: string): Promise<ConversationIndex> {
		const session = await this.findSession(sessionId);
		if (!session) throw new DesktopError("NOT_FOUND", "Session not found", { sessionId });
		if (!this.options.sessionFiles) return session;
		const summary = await this.options.sessionFiles.read(session.sessionPath);
		const updated = conversationFromSummary(session.projectId, summary, session);
		await this.options.metadata.saveConversation(updated);
		if (updated.projectId === this.activeProjectId)
			this.conversations = await this.options.metadata.listConversations(updated.projectId);
		return updated;
	}

	private async rebuildSessions(projectId: string): Promise<ConversationIndex[]> {
		const project = this.projects.find((candidate) => candidate.id === projectId);
		if (!project) throw new DesktopError("NOT_FOUND", "Project not found", { projectId });
		if (!this.options.sessionFiles) return this.options.metadata.listConversations(projectId);
		const result = await this.options.sessionFiles.scan(this.sessionDirectory(project));
		for (const message of result.diagnostics) this.recordDiagnostic("warning", "session-index", message);
		let stored = await this.options.metadata.listConversations(projectId);
		const emptySessionPaths = new Set(
			result.sessions.filter((summary) => !summary.hasMessages).map((summary) => summary.sessionPath),
		);
		for (const conversation of stored) {
			if (emptySessionPaths.has(conversation.sessionPath))
				await this.options.metadata.deleteConversation(conversation.id);
		}
		stored = await this.options.metadata.listConversations(projectId);
		const indexedPaths = new Set(result.sessions.map((summary) => summary.sessionPath));
		for (const conversation of stored) {
			if (!indexedPaths.has(conversation.sessionPath) && conversation.historyAccess !== "missing")
				await this.options.metadata.saveConversation({
					...conversation,
					historyAccess: "missing",
					status: "error",
				});
		}
		for (const summary of result.sessions) {
			if (!summary.hasMessages) continue;
			const existing = stored.find((candidate) => candidate.sessionPath === summary.sessionPath);
			await this.options.metadata.saveConversation(conversationFromSummary(projectId, summary, existing));
		}
		const conversations = await this.options.metadata.listConversations(projectId);
		if (projectId === this.activeProjectId) this.conversations = conversations;
		return conversations;
	}

	private async findSession(sessionId: string): Promise<ConversationIndex | undefined> {
		const current = this.conversations.find((candidate) => candidate.id === sessionId);
		if (current) return current;
		for (const project of this.projects) {
			const session = (await this.options.metadata.listConversations(project.id)).find(
				(candidate) => candidate.id === sessionId,
			);
			if (session) return session;
		}
		return undefined;
	}

	private async loadProjectConversations(project: Project): Promise<ConversationIndex[]> {
		let stored = await this.options.metadata.listConversations(project.id);
		if (!this.options.sessionFiles) return stored;
		const result = await this.options.sessionFiles.scan(this.sessionDirectory(project));
		for (const message of result.diagnostics) this.recordDiagnostic("warning", "session-index", message);
		const emptySessionPaths = new Set(
			result.sessions.filter((summary) => !summary.hasMessages).map((summary) => summary.sessionPath),
		);
		for (const conversation of stored) {
			if (
				emptySessionPaths.has(conversation.sessionPath) ||
				(conversation.title === "New conversation" &&
					conversation.leafId === null &&
					!(await this.options.sessionFiles.exists(conversation.sessionPath)))
			)
				await this.options.metadata.deleteConversation(conversation.id);
		}
		stored = await this.options.metadata.listConversations(project.id);
		const indexedPaths = new Set(result.sessions.map((summary) => summary.sessionPath));
		for (const conversation of stored) {
			if (!indexedPaths.has(conversation.sessionPath) && conversation.historyAccess !== "missing")
				await this.options.metadata.saveConversation({
					...conversation,
					historyAccess: "missing",
					status: "error",
				});
		}
		for (const summary of result.sessions) {
			if (!summary.hasMessages) continue;
			const existing = stored.find((candidate) => candidate.sessionPath === summary.sessionPath);
			await this.options.metadata.saveConversation(conversationFromSummary(project.id, summary, existing));
		}
		return this.options.metadata.listConversations(project.id);
	}

	private async startRuntime(project: Project, session?: ConversationIndex): Promise<void> {
		await this.stopRuntime("runtime replaced");
		const runtimeId = randomUUID();
		const sessionId = session?.id ?? randomUUID();
		this.activeProjectId = project.id;
		this.activeSessionId = session?.id ?? null;
		this.messages.clear();
		this.streamingAssistantMessageId = undefined;
		this.commands = [];
		this.runtime = asRuntimeSnapshot(project.id, sessionId, runtimeId, {
			status: "starting",
			sessionPath: session?.sessionPath ?? null,
			providerId: this.options.runtimeProviderId ?? "pi",
			thinkingLevel: session?.thinkingLevel ?? this.settings.defaultThinkingLevel,
		});
		this.emit({ type: "runtime.started", projectId: project.id, sessionId, runtimeId });
		try {
			const state = await this.requireRuntime().start(await this.buildRuntimeOptions(project, session, runtimeId));
			if (!this.runtime || this.runtime.runtimeId !== runtimeId) return;
			this.runtime = asRuntimeSnapshot(project.id, sessionId, runtimeId, { status: "ready", ...state });
			await this.refreshRuntimeMessages();
			await this.refreshCommands();
			const sessionPath = state.sessionPath ?? state.sessionRef;
			const providerId = state.providerId ?? this.options.runtimeProviderId ?? "pi";
			if (session && (sessionPath !== session.sessionPath || session.runtimeProviderId !== providerId)) {
				const updated = {
					...session,
					...(sessionPath ? { sessionPath } : {}),
					runtimeProviderId: providerId,
					runtimeSessionRef: state.sessionRef ?? sessionPath ?? session.runtimeSessionRef ?? null,
					sessionCodecId: session.sessionCodecId ?? (providerId === "pi" ? "pi-jsonl" : undefined),
					sessionFormatVersion: session.sessionFormatVersion ?? (providerId === "pi" ? 3 : null),
					updatedAt: now(),
				};
				if (this.draftSession?.id === session.id) this.draftSession = updated;
				else {
					await this.options.metadata.saveConversation(updated);
					this.conversations = await this.options.metadata.listConversations(project.id);
				}
			}
			this.emit({ type: "runtime.ready", projectId: project.id, sessionId, runtimeId, snapshot: this.runtime });
		} catch (error: unknown) {
			if (!this.runtime || this.runtime.runtimeId !== runtimeId) throw error;
			this.runtime = asRuntimeSnapshot(project.id, sessionId, runtimeId, {
				status: "error",
				sessionPath: session?.sessionPath ?? null,
				lastError: error instanceof Error ? error.message : String(error),
			});
			this.emit({
				type: "runtime.error",
				projectId: project.id,
				sessionId,
				runtimeId,
				error: this.runtime.lastError ?? "Runtime failed",
			});
			throw error;
		}
	}

	private async buildRuntimeOptions(project: Project, session: ConversationIndex | undefined, runtimeId: string) {
		const models: RuntimeModel[] = [];
		const env: Record<string, string> = {};
		const sensitiveValues: string[] = [];
		for (const profile of this.models.filter((candidate) => candidate.enabled)) {
			const apiKey =
				profile.credentialRef && this.options.secrets
					? await this.options.secrets.get(profile.credentialRef)
					: null;
			if (profile.credentialRef && !apiKey)
				this.recordDiagnostic("warning", "credentials", `Credential for ${profile.displayName} is unavailable`);
			models.push({
				providerId: profile.providerId,
				displayName: profile.displayName,
				baseUrl: profile.baseUrl,
				modelId: profile.modelId,
				apiKey,
			});
		}
		const defaultProfile = this.models.find(
			(candidate) => candidate.id === this.settings.defaultModelProfileId && candidate.enabled,
		);
		const sessionModel =
			session?.modelProvider && session.modelId
				? { providerId: session.modelProvider, modelId: session.modelId }
				: undefined;
		if (this.settings.webSearch.provider !== "disabled" && this.settings.webSearch.credentialRef) {
			const apiKey = this.options.secrets
				? await this.options.secrets.get(this.settings.webSearch.credentialRef)
				: null;
			if (apiKey) {
				env[this.settings.webSearch.provider === "brave" ? "BRAVE_SEARCH_API_KEY" : "TAVILY_API_KEY"] = apiKey;
				sensitiveValues.push(apiKey);
			} else {
				this.recordDiagnostic("warning", "web-search", "Web search credential is unavailable");
			}
		}
		return {
			cwd: project.rootPath,
			sessionRef: session?.sessionPath,
			sessionPath: session?.sessionPath,
			sessionDirectory: this.sessionDirectory(project),
			agentDirectory: this.agentDirectory(project),
			globalSystemPrompt: this.settings.globalSystemPrompt,
			projectTrusted: project.trustState === "trusted",
			skillDirectories: [...this.settings.skillDirectories],
			extensionPaths:
				this.settings.webSearch.provider !== "disabled" && this.options.webSearchExtensionPath
					? [this.options.webSearchExtensionPath]
					: [],
			env,
			sensitiveValues,
			models,
			selectedModel:
				sessionModel ??
				(defaultProfile ? { providerId: defaultProfile.providerId, modelId: defaultProfile.modelId } : undefined),
			thinkingLevel: session?.thinkingLevel ?? this.settings.defaultThinkingLevel,
			runtimeId,
			providerId: this.options.runtimeProviderId ?? "pi",
			tools: this.options.mcp?.listToolDefinitions?.(
				this.activeProjectId ?? undefined,
				project.trustState === "trusted",
			),
		};
	}

	private async stopRuntime(reason: string): Promise<void> {
		if (!this.runtime) return;
		const previous = this.runtime;
		this.runtime = null;
		try {
			await this.runtimePort.stop();
		} finally {
			this.emit({
				type: "runtime.stopped",
				projectId: previous.projectId,
				sessionId: previous.sessionId,
				runtimeId: previous.runtimeId,
				reason,
			});
		}
	}

	private async restartActiveRuntime(reason: string): Promise<void> {
		const project = this.projects.find((candidate) => candidate.id === this.activeProjectId);
		const session = this.activeConversation();
		if (!project || !session) return;
		await this.stopRuntime(reason);
		await this.startRuntime(project, session);
	}

	private requireRuntimeState(): RuntimeSnapshot {
		if (!this.runtime) throw new DesktopError("NOT_READY", "No active Pi runtime");
		return { ...this.runtime };
	}

	private requireRuntime(): AgentRuntimePort {
		return this.runtimePort;
	}

	private activeConversation(): ConversationIndex | undefined {
		return (
			this.conversations.find((candidate) => candidate.id === this.activeSessionId) ??
			(this.draftSession?.id === this.activeSessionId ? this.draftSession : undefined)
		);
	}

	private requireFolderPicker() {
		if (!this.options.ports.folderPicker)
			throw new DesktopError("NOT_SUPPORTED", "Native folder picker is unavailable");
		return this.options.ports.folderPicker;
	}

	private async prompt(text: string, queueMode: "prompt" | "steer" | "followUp"): Promise<null> {
		if (!this.runtime || !this.activeSessionId)
			throw new DesktopError("NOT_READY", "Create or select a session before prompting");
		if (!text.trim()) throw new DesktopError("INVALID_ARGUMENT", "Prompt cannot be empty");
		if (this.runtime.isStreaming && queueMode === "prompt")
			throw new DesktopError("CONFLICT", "Choose steer or follow-up while Pi is streaming");
		if (!this.runtime.isStreaming && queueMode !== "prompt")
			throw new DesktopError("CONFLICT", "Queue modes are only available while Pi is streaming");
		const session = this.activeConversation();
		if (session && session.title === "New conversation") {
			const updated = { ...session, title: truncateTitle(text), updatedAt: now() };
			if (this.draftSession?.id === session.id) this.draftSession = updated;
			else {
				await this.options.metadata.saveConversation(updated);
				this.conversations = await this.options.metadata.listConversations(updated.projectId);
			}
			await this.requireRuntime().setSessionName(updated.title);
		}
		if (queueMode === "steer") await this.requireRuntime().steer(text);
		else if (queueMode === "followUp") await this.requireRuntime().followUp(text);
		else await this.requireRuntime().prompt(text);
		return null;
	}

	private async retryLast(): Promise<null> {
		if (this.runtime?.isStreaming) throw new DesktopError("CONFLICT", "Wait for the current response to finish");
		const message = [...this.messages.values()].reverse().find((candidate) => candidate.role === "user");
		const text = message?.parts
			.map((part) => part.text)
			.join("")
			.trim();
		if (!text) throw new DesktopError("NOT_FOUND", "No user message is available to retry");
		return this.prompt(text, "prompt");
	}

	private async abort(): Promise<null> {
		if (!this.runtime) throw new DesktopError("NOT_READY", "No active Pi runtime");
		await this.requireRuntime().abort();
		return null;
	}

	private async setThinkingLevel(level: ThinkingLevel): Promise<null> {
		await this.requireRuntime().setThinkingLevel(level);
		if (this.runtime) this.runtime.thinkingLevel = level;
		await this.updateActiveConversation({ thinkingLevel: level });
		return null;
	}

	private async setModel(profileId: string): Promise<null> {
		const profile = this.models.find((candidate) => candidate.id === profileId && candidate.enabled);
		if (!profile) throw new DesktopError("NOT_FOUND", "Enabled model profile not found", { profileId });
		await this.requireRuntime().setModel(profile.providerId, profile.modelId);
		if (this.runtime) {
			this.runtime.modelProvider = profile.providerId;
			this.runtime.modelId = profile.modelId;
		}
		await this.updateActiveConversation({ modelProvider: profile.providerId, modelId: profile.modelId });
		return null;
	}

	private async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
		const next: AppSettings = {
			...this.settings,
			...patch,
			skillDirectories: [...(patch.skillDirectories ?? this.settings.skillDirectories)],
			webSearch: { ...this.settings.webSearch, ...(patch.webSearch ?? {}) },
		};
		if (patch.globalSystemPrompt !== undefined && patch.globalSystemPrompt.length > 100_000)
			throw new DesktopError("INVALID_ARGUMENT", "Global system prompt is too long");
		if (patch.defaultThinkingLevel !== undefined && !isThinkingLevel(patch.defaultThinkingLevel))
			throw new DesktopError("INVALID_ARGUMENT", "Default thinking level is invalid");
		if (patch.theme !== undefined && !isAppTheme(patch.theme))
			throw new DesktopError("INVALID_ARGUMENT", "Theme must be light or dark");
		if (patch.conversationFontSize !== undefined && !isFontSize(patch.conversationFontSize, 14, 20))
			throw new DesktopError("INVALID_ARGUMENT", "Conversation font size must be an integer from 14 to 20");
		if (patch.sidebarFontSize !== undefined && !isFontSize(patch.sidebarFontSize, 12, 18))
			throw new DesktopError("INVALID_ARGUMENT", "Sidebar font size must be an integer from 12 to 18");
		if (patch.skillDirectories !== undefined) {
			const paths = await Promise.all(patch.skillDirectories.map((path) => canonicalizeResourcePath(path)));
			next.skillDirectories = [...new Set(paths)];
		}
		if (patch.invokeShortcut !== undefined) {
			next.invokeShortcut = normalizeShortcut(patch.invokeShortcut, this.options.platform);
			await this.registerShortcut(next.invokeShortcut);
		}
		if (patch.closeToTray !== undefined) await this.options.ports.window.setCloseToTray(next.closeToTray);
		await this.options.metadata.saveSettings(next);
		this.settings = next;
		return {
			...this.settings,
			skillDirectories: [...this.settings.skillDirectories],
			webSearch: { ...this.settings.webSearch },
		};
	}

	private async resetSetting(key: keyof AppSettings): Promise<AppSettings> {
		const defaults = {
			...DEFAULT_APP_SETTINGS,
			invokeShortcut: defaultInvokeShortcut(this.options.platform),
			skillDirectories: [],
		};
		return this.updateSettings({ [key]: defaults[key] });
	}

	private async updateWebSearch(
		provider: AppSettings["webSearch"]["provider"],
		apiKey?: string,
		clearCredential?: boolean,
	): Promise<AppSettings> {
		let credentialRef = this.settings.webSearch.credentialRef;
		if (clearCredential && credentialRef && this.options.secrets) {
			await this.options.secrets.delete(credentialRef);
			credentialRef = null;
		}
		if (apiKey?.trim()) {
			if (!this.options.secrets) throw new DesktopError("NOT_SUPPORTED", "Secure credential storage is unavailable");
			credentialRef = await this.options.secrets.set(apiKey.trim(), credentialRef ?? undefined);
		}
		const settings = await this.updateSettings({ webSearch: { provider, credentialRef } });
		if (this.runtime) await this.restartActiveRuntime("web search settings changed");
		return settings;
	}

	private validateModelDraft(input: ModelProfileDraft, existingId?: string): ModelProfileDraft {
		if (!input.providerId.trim() || !/^[a-z0-9][a-z0-9._-]*$/i.test(input.providerId.trim()))
			throw new DesktopError("INVALID_ARGUMENT", "Provider ID is invalid");
		if (!input.modelId.trim()) throw new DesktopError("INVALID_ARGUMENT", "Model ID is required");
		if (!input.displayName.trim()) throw new DesktopError("INVALID_ARGUMENT", "Model display name is required");
		const baseUrl = normalizeModelBaseUrl(input.baseUrl);
		const duplicate = this.models.find(
			(candidate) =>
				candidate.id !== existingId &&
				candidate.providerId === input.providerId.trim() &&
				candidate.modelId === input.modelId.trim(),
		);
		if (duplicate) throw new DesktopError("CONFLICT", "A model with this provider and ID already exists");
		return {
			...input,
			providerId: input.providerId.trim(),
			modelId: input.modelId.trim(),
			displayName: input.displayName.trim(),
			baseUrl,
		};
	}

	private async createModel(input: ModelProfileDraft, apiKey?: string): Promise<ModelProfile> {
		const draft = this.validateModelDraft(input);
		const timestamp = now();
		const profile: ModelProfile = {
			...draft,
			id: randomUUID(),
			credentialRef: null,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		if (apiKey?.length) {
			if (!this.options.secrets) throw new DesktopError("NOT_SUPPORTED", "Secure credential storage is unavailable");
			profile.credentialRef = await this.options.secrets.set(apiKey);
		}
		try {
			await this.options.metadata.saveModel(profile);
		} catch (error: unknown) {
			if (profile.credentialRef && this.options.secrets) await this.options.secrets.delete(profile.credentialRef);
			throw error;
		}
		this.models = await this.options.metadata.listModels();
		await this.ensureDefaultModel();
		await this.restartActiveRuntime("model profiles changed");
		return profile;
	}

	private async updateModel(
		profileId: string,
		patch: ModelProfilePatch,
		apiKey?: string,
		clearCredential = false,
	): Promise<ModelProfile> {
		const profile = this.models.find((candidate) => candidate.id === profileId);
		if (!profile) throw new DesktopError("NOT_FOUND", "Model profile not found", { profileId });
		const draft = this.validateModelDraft({
			providerId: patch.providerId ?? profile.providerId,
			displayName: patch.displayName ?? profile.displayName,
			baseUrl: patch.baseUrl ?? profile.baseUrl,
			modelId: patch.modelId ?? profile.modelId,
			enabled: patch.enabled ?? profile.enabled,
		});
		let credentialRef = profile.credentialRef;
		if (clearCredential && credentialRef && this.options.secrets) {
			await this.options.secrets.delete(credentialRef);
			credentialRef = null;
		}
		if (apiKey?.length) {
			if (!this.options.secrets) throw new DesktopError("NOT_SUPPORTED", "Secure credential storage is unavailable");
			credentialRef = await this.options.secrets.set(apiKey, credentialRef ?? undefined);
		}
		const updated: ModelProfile = {
			...draft,
			id: profile.id,
			credentialRef,
			createdAt: profile.createdAt,
			updatedAt: now(),
		};
		await this.options.metadata.saveModel(updated);
		this.models = await this.options.metadata.listModels();
		await this.ensureDefaultModel();
		await this.restartActiveRuntime("model profiles changed");
		return updated;
	}

	private async deleteModel(profileId: string): Promise<null> {
		const profile = this.models.find((candidate) => candidate.id === profileId);
		if (!profile) throw new DesktopError("NOT_FOUND", "Model profile not found", { profileId });
		if (profile.credentialRef && this.options.secrets) await this.options.secrets.delete(profile.credentialRef);
		await this.options.metadata.deleteModel(profileId);
		this.models = await this.options.metadata.listModels();
		await this.ensureDefaultModel();
		await this.restartActiveRuntime("model profiles changed");
		return null;
	}

	private async testModelConnection(profileId: string): Promise<ModelConnectionResult> {
		const profile = this.models.find((candidate) => candidate.id === profileId);
		if (!profile) throw new DesktopError("NOT_FOUND", "Model profile not found", { profileId });
		if (!this.options.modelConnection)
			throw new DesktopError("NOT_SUPPORTED", "Model connection testing is unavailable");
		const apiKey =
			profile.credentialRef && this.options.secrets ? await this.options.secrets.get(profile.credentialRef) : null;
		return this.options.modelConnection.test(profile, apiKey);
	}

	private async setDefaultModel(profileId: string | null): Promise<AppSettings> {
		if (profileId !== null && !this.models.some((model) => model.id === profileId && model.enabled))
			throw new DesktopError("NOT_FOUND", "Enabled model profile not found", { profileId });
		return this.updateSettings({
			defaultModelProfileId: profileId ?? this.models.find((model) => model.enabled)?.id ?? null,
		});
	}

	private async ensureDefaultModel(): Promise<void> {
		if (this.models.some((model) => model.id === this.settings.defaultModelProfileId && model.enabled)) return;
		await this.updateSettings({ defaultModelProfileId: this.models.find((model) => model.enabled)?.id ?? null });
	}

	private async reloadSkills(): Promise<SkillCommand[]> {
		await this.restartActiveRuntime("skills reloaded");
		return this.commands.filter((command) => command.source === "skill");
	}

	private async reconcileMcp(): Promise<void> {
		if (!this.options.mcp) return;
		for (const profile of this.mcpProfiles) {
			if (!profile.enabled || (profile.projectId !== null && profile.projectId !== this.activeProjectId)) {
				await this.options.mcp.stop(profile.id, "project scope changed");
				continue;
			}
			const snapshot = await this.options.mcp.start(profile);
			this.mcpServers = this.options.mcp.list();
			if (snapshot.status === "error")
				this.recordDiagnostic("error", "mcp", snapshot.lastError ?? "MCP server failed");
		}
		this.mcpServers = this.options.mcp.list();
	}

	private async createMcpServer(input: McpServerDraft): Promise<McpServerSnapshot> {
		if (!this.options.mcp) throw new DesktopError("NOT_SUPPORTED", "MCP is unavailable");
		const profile: McpServerProfile = { ...input, id: randomUUID(), args: [...input.args], env: { ...input.env } };
		await this.options.metadata.saveMcpServer(profile);
		this.mcpProfiles = await this.options.metadata.listMcpServers();
		this.options.mcp.setProfiles(this.mcpProfiles);
		const snapshot =
			profile.enabled && (profile.projectId === null || profile.projectId === this.activeProjectId)
				? await this.options.mcp.start(profile)
				: (this.options.mcp.list().find((candidate) => candidate.profile.id === profile.id) ?? {
						profile,
						status: "stopped",
						toolCount: 0,
						lastError: null,
						startedAt: null,
					});
		this.mcpServers = this.options.mcp.list();
		return publicMcpSnapshot(snapshot);
	}

	private async updateMcpServer(serverId: string, patch: McpServerPatch): Promise<McpServerSnapshot> {
		const current = this.mcpProfiles.find((profile) => profile.id === serverId);
		if (!current) throw new DesktopError("NOT_FOUND", "MCP server not found", { serverId });
		const updated: McpServerProfile = {
			...current,
			...patch,
			args: patch.args ? [...patch.args] : [...current.args],
			env: patch.env ? { ...patch.env } : { ...current.env },
		};
		await this.options.metadata.saveMcpServer(updated);
		this.mcpProfiles = await this.options.metadata.listMcpServers();
		this.options.mcp?.setProfiles(this.mcpProfiles);
		await this.options.mcp?.stop(serverId, "profile updated");
		const snapshot =
			this.options.mcp &&
			updated.enabled &&
			(updated.projectId === null || updated.projectId === this.activeProjectId)
				? await this.options.mcp.start(updated)
				: { profile: updated, status: "stopped" as const, toolCount: 0, lastError: null, startedAt: null };
		this.mcpServers = this.options.mcp?.list() ?? [];
		return publicMcpSnapshot(snapshot);
	}

	private async deleteMcpServer(serverId: string): Promise<null> {
		if (!this.mcpProfiles.some((profile) => profile.id === serverId))
			throw new DesktopError("NOT_FOUND", "MCP server not found", { serverId });
		await this.options.mcp?.stop(serverId, "server deleted");
		await this.options.metadata.deleteMcpServer(serverId);
		this.mcpProfiles = await this.options.metadata.listMcpServers();
		this.options.mcp?.setProfiles(this.mcpProfiles);
		this.mcpServers = this.options.mcp?.list() ?? [];
		return null;
	}

	private async setMcpEnabled(serverId: string, enabled: boolean): Promise<McpServerSnapshot> {
		return this.updateMcpServer(serverId, { enabled });
	}

	private async testMcpConnection(serverId: string): Promise<McpServerSnapshot> {
		const profile = this.mcpProfiles.find((candidate) => candidate.id === serverId);
		if (!profile || !this.options.mcp) throw new DesktopError("NOT_FOUND", "MCP server not found", { serverId });
		return publicMcpSnapshot(await this.options.mcp.test(profile));
	}

	private async refreshRuntimeMessages(): Promise<void> {
		const previousMessages = collapseMessages([...this.messages.values()]);
		const previous = new Map(previousMessages.map((message) => [message.id, message]));
		const messages = collapseMessages(await this.requireRuntime().getMessages());
		this.messages.clear();
		const consumedPreviousIds = new Set<string>();
		for (const message of messages) {
			const current =
				(previous.get(message.id) && !consumedPreviousIds.has(message.id) ? previous.get(message.id) : undefined) ??
				[...previous.values()].find(
					(candidate) =>
						!consumedPreviousIds.has(candidate.id) &&
						candidate.role === message.role &&
						messageFingerprint(candidate) === messageFingerprint(message),
				) ??
				(message.role === "assistant" && !hasVisibleMessageContent(message)
					? [...previous.values()]
							.reverse()
							.find(
								(candidate) =>
									candidate.role === "assistant" &&
									hasVisibleMessageContent(candidate) &&
									!consumedPreviousIds.has(candidate.id),
							)
					: undefined);
			if (
				message.role === "assistant" &&
				message.status !== "streaming" &&
				!hasVisibleMessageContent(message) &&
				!(current && hasVisibleMessageContent(current))
			)
				continue;
			const next =
				current && hasVisibleMessageContent(current) && !hasVisibleMessageContent(message)
					? cloneMessage(current)
					: cloneMessage(message);
			if (current?.durationMs !== undefined && next.durationMs === undefined) next.durationMs = current.durationMs;
			if (current) {
				consumedPreviousIds.add(current.id);
				if (current.id !== next.id) next.id = current.id;
			}
			this.messages.set(next.id, next);
		}
		for (const [messageId, message] of previous) {
			if (!consumedPreviousIds.has(messageId) && !this.messages.has(messageId))
				this.messages.set(messageId, cloneMessage(message));
		}
		if (this.runtime) this.runtime.messageCount = this.messages.size;
	}

	private async refreshCommands(): Promise<void> {
		this.commands = (await this.requireRuntime().getCommands()).map((command) => ({ ...command }));
		if (this.runtime) this.emit({ type: "skills.changed", ...this.runtime, commands: this.commands });
	}

	private async updateActiveConversation(patch: Partial<ConversationIndex>): Promise<void> {
		if (!this.activeSessionId) return;
		const session = this.activeConversation();
		if (!session) return;
		const updated = { ...session, ...patch, updatedAt: now() };
		if (this.draftSession?.id === session.id) {
			this.draftSession = updated;
			return;
		}
		await this.options.metadata.saveConversation(updated);
		this.conversations = await this.options.metadata.listConversations(updated.projectId);
	}

	private async promoteDraftSession(): Promise<void> {
		if (this.draftPromotion) return this.draftPromotion;
		this.draftPromotion = (async () => {
			const draft = this.draftSession;
			if (!draft || draft.id !== this.activeSessionId) return;
			if (this.options.sessionFiles) {
				let persisted = false;
				for (let attempt = 0; attempt < 20; attempt += 1) {
					if (await this.options.sessionFiles.exists(draft.sessionPath)) {
						persisted = true;
						break;
					}
					await new Promise<void>((resolve) => setTimeout(resolve, 50));
				}
				if (!persisted) return;
			}
			if (this.draftSession?.id !== draft.id || this.activeSessionId !== draft.id) return;
			const updated = { ...draft, status: "idle" as const, updatedAt: now() };
			await this.options.metadata.saveConversation(updated);
			this.conversations = await this.options.metadata.listConversations(updated.projectId);
			if (this.draftSession?.id === updated.id) this.draftSession = null;
			if (this.runtime)
				this.emit({
					type: "session.changed",
					...this.runtime,
					sessionId: updated.id,
					projectId: updated.projectId,
				});
		})();
		try {
			await this.draftPromotion;
		} finally {
			this.draftPromotion = undefined;
		}
	}

	private handleAgentEvent(event: AgentEvent): void {
		if (!this.runtime || event.runtimeId !== this.runtime.runtimeId) return;
		const identity = {
			projectId: this.runtime.projectId,
			sessionId: this.runtime.sessionId,
			runtimeId: this.runtime.runtimeId,
		};
		switch (event.type) {
			case "ready":
				this.runtime = asRuntimeSnapshot(identity.projectId, identity.sessionId, identity.runtimeId, {
					status: "ready",
					...event.state,
				});
				this.emit({ type: "runtime.ready", ...identity, snapshot: this.runtime });
				break;
			case "state_changed":
				this.runtime = asRuntimeSnapshot(identity.projectId, identity.sessionId, identity.runtimeId, {
					...this.runtime,
					status: event.state.isStreaming ? "streaming" : "ready",
					...event.state,
				});
				void this.updateActiveConversation({
					status: this.runtime.isStreaming ? "streaming" : "idle",
					thinkingLevel: this.runtime.thinkingLevel,
					modelProvider: this.runtime.modelProvider,
					modelId: this.runtime.modelId,
				}).catch(() => undefined);
				if (!this.runtime.isStreaming) {
					void this.promoteDraftSession().catch(() => undefined);
					void this.refreshRuntimeMessages().catch(() => undefined);
					this.assistantStartedAt.clear();
					this.streamingAssistantMessageId = undefined;
					this.emit({ type: "runtime.ready", ...identity, snapshot: this.runtime });
				}
				break;
			case "message_started":
				this.messages.set(event.message.id, cloneMessage(event.message));
				if (event.message.role === "assistant") {
					this.streamingAssistantMessageId = event.message.id;
					this.assistantStartedAt.set(event.message.id, performance.now());
				}
				this.runtime.status = "streaming";
				this.runtime.isStreaming = true;
				this.runtime.messageCount = this.messages.size;
				this.emit({ type: "message.started", ...identity, message: cloneMessage(event.message) });
				break;
			case "message_delta":
				this.applyMessageDelta(event.messageId, event.part, event.delta);
				this.emit({
					type: "message.delta",
					...identity,
					messageId: event.messageId,
					part: event.part,
					delta: event.delta,
				});
				break;
			case "message_finished": {
				const completedMessage = cloneMessage(event.message);
				const previous =
					this.messages.get(event.message.id) ??
					(event.message.role === "assistant" && this.streamingAssistantMessageId
						? this.messages.get(this.streamingAssistantMessageId)
						: undefined);
				if (previous && previous.id !== completedMessage.id) {
					this.messages.delete(completedMessage.id);
					completedMessage.id = previous.id;
				}
				if (completedMessage.role === "assistant") {
					const startedAt =
						this.assistantStartedAt.get(completedMessage.id) ??
						(previous ? this.assistantStartedAt.get(previous.id) : undefined);
					if (startedAt !== undefined) completedMessage.durationMs = Math.max(0, performance.now() - startedAt);
					this.assistantStartedAt.delete(completedMessage.id);
					if (previous && previous.id !== completedMessage.id) this.assistantStartedAt.delete(previous.id);
				}
				if (previous && !hasVisibleMessageContent(completedMessage) && hasVisibleMessageContent(previous))
					completedMessage.parts = previous.parts.map((part) => ({ ...part }));
				if (
					event.message.role === "assistant" &&
					!hasVisibleMessageContent(completedMessage) &&
					!(previous && hasVisibleMessageContent(previous))
				) {
					this.messages.delete(completedMessage.id);
					this.runtime.messageCount = this.messages.size;
					break;
				}
				this.messages.set(completedMessage.id, completedMessage);
				this.runtime.messageCount = this.messages.size;
				this.emit({ type: "message.finished", ...identity, message: cloneMessage(completedMessage) });
				break;
			}
			case "aborted":
				if (event.messageId) this.assistantStartedAt.delete(event.messageId);
				this.runtime.status = "ready";
				this.runtime.isStreaming = false;
				void this.updateActiveConversation({ status: "aborted" }).catch(() => undefined);
				this.emit({ type: "message.aborted", ...identity, messageId: event.messageId });
				break;
			case "tool_started":
				this.applyToolEvent(event.messageId, event.toolCallId, {
					text: "",
					toolName: event.toolName,
					status: "started",
				});
				this.emit({
					type: "tool.started",
					...identity,
					messageId: this.resolveAssistantMessageId(event.messageId),
					toolName: event.toolName,
					toolCallId: event.toolCallId,
				});
				break;
			case "tool_update":
				this.applyToolEvent(event.messageId, event.toolCallId, { text: event.text, status: "updated" });
				this.emit({
					type: "tool.update",
					...identity,
					messageId: this.resolveAssistantMessageId(event.messageId),
					toolCallId: event.toolCallId,
					text: event.text,
				});
				break;
			case "tool_finished":
				this.applyToolEvent(event.messageId, event.toolCallId, {
					text: event.text,
					status: event.failed ? "failed" : "finished",
				});
				this.emit({
					type: "tool.finished",
					...identity,
					messageId: this.resolveAssistantMessageId(event.messageId),
					toolCallId: event.toolCallId,
					text: event.text,
					failed: event.failed,
				});
				break;
			case "diagnostic":
				this.recordDiagnostic(event.level, "pi-runtime", event.message);
				break;
			case "error":
				this.runtime.status = "error";
				this.runtime.isStreaming = false;
				this.runtime.lastError = event.error;
				void this.updateActiveConversation({ status: "error" }).catch(() => undefined);
				this.emit({ type: "runtime.error", ...identity, error: event.error });
				this.recordDiagnostic("error", "pi-runtime", event.error);
				break;
		}
	}

	private handleMcpEvent(event: McpPortEvent): void {
		this.mcpServers = this.options.mcp?.list() ?? this.mcpServers;
		if (event.snapshot) {
			const publicSnapshot = publicMcpSnapshot(event.snapshot);
			this.emit({ type: "mcp.serverChanged", server: publicSnapshot });
		} else if (event.serverId) {
			const snapshot = this.mcpServers.find((candidate) => candidate.profile.id === event.serverId);
			if (snapshot) this.emit({ type: "mcp.serverChanged", server: publicMcpSnapshot(snapshot) });
		}
		if (event.tools) {
			const tools = event.tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
			this.emit({ type: "mcp.toolsChanged", tools });
			const project = this.projects.find((candidate) => candidate.id === this.activeProjectId);
			const definitions = this.options.mcp?.listToolDefinitions?.(
				this.activeProjectId ?? undefined,
				project?.trustState === "trusted",
			);
			if (definitions && this.runtimePort.setTools) void this.runtimePort.setTools(definitions);
		}
		if (event.type === "server.error" && event.error) this.recordDiagnostic("error", "mcp", event.error);
		if (event.type === "consent.required" && event.request) {
			this.consentRequests = [
				...this.consentRequests.filter((request) => request.requestId !== event.request?.requestId),
				event.request,
			];
			this.emit({ type: "mcp.consentRequired", request: { ...event.request } });
		}
		if (event.type === "consent.resolved" && event.requestId) {
			this.consentRequests = this.consentRequests.filter((request) => request.requestId !== event.requestId);
			this.emit({ type: "mcp.consentResolved", requestId: event.requestId, approved: event.approved === true });
		}
	}

	private applyMessageDelta(messageId: string, partType: "text" | "thinking", delta: string): void {
		const message = this.messages.get(messageId);
		if (!message) return;
		const part = message.parts.find((candidate) => candidate.type === partType);
		if (part) part.text += delta;
		else message.parts.push({ type: partType, text: delta });
	}

	private resolveAssistantMessageId(messageId: string): string {
		return this.messages.has(messageId) ? messageId : (this.streamingAssistantMessageId ?? messageId);
	}

	private applyToolEvent(
		messageId: string,
		toolCallId: string,
		patch: { text?: string; toolName?: string; status?: "started" | "updated" | "finished" | "failed" },
	): void {
		const assistantId = this.resolveAssistantMessageId(messageId);
		const message = this.messages.get(assistantId);
		if (!message) return;
		const part = message.parts.find((candidate) => candidate.type === "tool" && candidate.toolCallId === toolCallId);
		if (part && part.type === "tool") {
			if (patch.text !== undefined) part.text = patch.text;
			if (patch.toolName !== undefined) part.toolName = patch.toolName;
			if (patch.status !== undefined) part.status = patch.status;
			return;
		}
		message.parts.push({
			type: "tool",
			text: patch.text ?? "",
			toolName: patch.toolName,
			toolCallId,
			status: patch.status ?? "started",
		});
	}

	private recordDiagnostic(level: Diagnostic["level"], component: string, message: string, requestId?: string): void {
		const diagnostic: Diagnostic = {
			level,
			component,
			message,
			projectId: this.runtime?.projectId,
			sessionId: this.runtime?.sessionId,
			runtimeId: this.runtime?.runtimeId,
			requestId,
			createdAt: now(),
		};
		this.diagnostics.push(diagnostic);
		if (this.diagnostics.length > 100) this.diagnostics.shift();
		this.options.logger?.diagnostic(diagnostic);
		if (this.runtime) this.emit({ type: "diagnostic", ...this.runtime, diagnostic });
	}

	private sessionDirectory(project: Project): string {
		return this.options.sessionDirectory?.(project) ?? join(project.rootPath, ".pi-desktop", "sessions");
	}

	private agentDirectory(project: Project): string {
		return this.options.agentDirectory ?? join(project.rootPath, ".pi-desktop", "agent");
	}

	private emit(event: DesktopEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	dispose(): void {
		this.piUnsubscribe?.();
		this.piUnsubscribe = undefined;
		this.mcpUnsubscribe?.();
		this.mcpUnsubscribe = undefined;
	}
}
