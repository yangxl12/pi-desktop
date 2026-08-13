import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
	AppSettings,
	ConversationIndex,
	DesktopApprovalRequest,
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
	SkillInstallationSnapshot,
	SkillInstallScope,
	SkillSource,
	ThinkingLevel,
	TrustState,
} from "@earendil-works/pi-desktop-protocol";
import { DesktopError, toDesktopError } from "@earendil-works/pi-desktop-protocol";
import { createDesktopManagementTools } from "./desktop-management-tools.ts";
import { DEFAULT_APP_SETTINGS } from "./memory-repository.ts";
import { ModelGateway } from "./model-gateway.ts";
import { normalizeModelBaseUrl } from "./models.ts";
import { canonicalizeProjectPath, canonicalizeResourcePath, projectName } from "./paths.ts";
import { PerformanceMetrics } from "./performance-metrics.ts";
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
	SkillPackagePort,
} from "./ports.ts";
import { defaultInvokeShortcut, normalizeShortcut } from "./shortcuts.ts";
import { SkillInstallService } from "./skill-install-service.ts";

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
	skillPackage?: SkillPackagePort;
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

function isDeepSeekModel(profile: { providerId: string; baseUrl: string }): boolean {
	if (profile.providerId.trim().toLowerCase() === "deepseek") return true;
	try {
		return new URL(profile.baseUrl).hostname.toLowerCase() === "api.deepseek.com";
	} catch {
		return false;
	}
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
		availableThinkingLevels: state.availableThinkingLevels ?? [...THINKING_LEVELS],
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

interface PendingApproval {
	resolve(approved: boolean): void;
	timer: ReturnType<typeof setTimeout>;
}

export function normalizeMcpProfileSource(
	source: string,
): McpServerDraft & { launchKind: "http" | "managed-npm" | "executable" } {
	const defaults = {
		name: "Imported MCP",
		namespace: "imported",
		transport: "stdio" as const,
		command: null as string | null,
		args: [] as string[],
		env: {} as Record<string, string>,
		url: null as string | null,
		credentialRef: null as string | null,
		enabled: true,
		timeoutMs: 30_000,
		maxOutputBytes: 1_048_576,
		projectId: null as string | null,
	};
	try {
		const value = JSON.parse(source) as Record<string, unknown>;
		const command = typeof value.command === "string" ? value.command : null;
		const args = Array.isArray(value.args)
			? value.args.filter((item): item is string => typeof item === "string")
			: [];
		const url = typeof value.url === "string" ? value.url : null;
		const launchKind =
			value.launchKind === "managed-npm" || value.launchKind === "executable" || value.launchKind === "http"
				? value.launchKind
				: url
					? "http"
					: command?.toLowerCase() === "npx" || command?.toLowerCase() === "npx.cmd"
						? "managed-npm"
						: "executable";
		return {
			...defaults,
			name: typeof value.name === "string" ? value.name : defaults.name,
			namespace: typeof value.namespace === "string" ? value.namespace : "imported",
			transport: launchKind === "http" ? "http" : "stdio",
			command,
			args,
			url,
			credentialRef: typeof value.credentialRef === "string" ? value.credentialRef : null,
			enabled: typeof value.enabled === "boolean" ? value.enabled : true,
			timeoutMs: Number.isInteger(value.timeoutMs) ? Number(value.timeoutMs) : defaults.timeoutMs,
			maxOutputBytes: Number.isInteger(value.maxOutputBytes)
				? Number(value.maxOutputBytes)
				: defaults.maxOutputBytes,
			projectId: typeof value.projectId === "string" ? value.projectId : null,
			launchKind,
			packageSpec:
				typeof value.packageSpec === "string"
					? value.packageSpec
					: launchKind === "managed-npm"
						? (args.find((arg) => arg !== "-y" && !arg.startsWith("-")) ?? null)
						: null,
			packageVersion: typeof value.packageVersion === "string" ? value.packageVersion : null,
			bin: typeof value.bin === "string" ? value.bin : null,
			scope: value.scope === "project" ? "project" : "global",
		};
	} catch {
		const tokens = source.trim().split(/\s+/);
		if (tokens[0] === "npx") {
			const packageSpec = tokens.find((token) => token !== "npx" && token !== "-y" && !token.startsWith("-")) ?? "";
			return {
				...defaults,
				name: packageSpec || defaults.name,
				namespace: packageSpec.replace(/[^a-z0-9_-]/gi, "_").slice(0, 32) || "mcp",
				command: "npx",
				args: tokens.slice(1),
				launchKind: "managed-npm",
				packageSpec,
			};
		}
		return { ...defaults, command: tokens[0] || null, args: tokens.slice(1), launchKind: "executable" };
	}
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
	private approvalRequests: DesktopApprovalRequest[] = [];
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	private commands: SkillCommand[] = [];
	private skillInstallations: SkillInstallationSnapshot[] = [];
	private readonly skillService: SkillInstallService | undefined;
	private runtimeToolSet = {
		desiredGeneration: 0,
		appliedGeneration: null as number | null,
		toolNames: [] as string[],
		lastError: null as string | null,
	};
	private activeProjectId: string | null = null;
	private activeSessionId: string | null = null;
	private draftSession: ConversationIndex | null = null;
	private draftPromotion: Promise<void> | undefined;
	private runtime: RuntimeSnapshot | null = null;
	private readonly runtimePort: AgentRuntimePort;
	private readonly modelGateway: ModelGateway;
	private readonly performance = new PerformanceMetrics();
	private piUnsubscribe: (() => void) | undefined;
	private mcpUnsubscribe: (() => void) | undefined;
	private registeredShortcut: string | undefined;
	private initialized = false;

	constructor(options: ApplicationOptions) {
		this.options = options;
		const runtimePort = options.runtimeService ?? options.pi;
		if (!runtimePort) throw new Error("A runtime port is required");
		this.runtimePort = runtimePort;
		this.modelGateway = new ModelGateway(options.secrets);
		this.piUnsubscribe = this.runtimePort.subscribe((event) => this.handleAgentEvent(event));
		this.mcpUnsubscribe = options.mcp?.subscribe((event) => this.handleMcpEvent(event));
		if (options.skillPackage)
			this.skillService = new SkillInstallService({
				port: options.skillPackage,
				metadata: options.metadata,
				onProgress: (progress) => this.emit({ type: "skills.installProgress", progress }),
				onReload: async () => {
					if (this.runtime) await this.restartActiveRuntime("skills changed");
					return this.commands;
				},
			});
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
		this.skillInstallations = this.skillService
			? await this.skillService.reconcile()
			: ((await this.options.metadata.listSkillInstallations?.()) ?? []);
		this.emit({
			type: "skills.catalogChanged",
			installations: this.skillInstallations.map((item) => ({
				...item,
				diagnostics: [...item.diagnostics],
				source: { ...item.source },
			})),
		});
		this.mcpProfiles = await this.options.metadata.listMcpServers();
		this.options.mcp?.setProfiles(this.mcpProfiles);
		this.mcpServers = this.options.mcp?.list() ?? [];
		await this.options.ports.tray.create({
			open: () => void this.showWindow(),
			settings: () => void this.showWindow(),
			quit: () => void this.quit(),
		});
		try {
			await this.registerShortcut(this.settings.invokeShortcut);
		} catch (error: unknown) {
			// A conflicting global shortcut (e.g. taken by another app) must not
			// take down the whole host; surface it in diagnostics instead.
			this.recordDiagnostic("warning", "shortcut", toDesktopError(error).message);
		}
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
			skillInstallations: this.skillInstallations.map((item) => ({
				...item,
				diagnostics: [...item.diagnostics],
				source: { ...item.source },
			})),
			mcpServers: this.mcpServers.map((server) => ({
				...server,
				profile: { ...server.profile, args: [...server.profile.args], env: { ...server.profile.env } },
			})),
			mcpTools: this.options.mcp?.listTools(this.activeProjectId ?? undefined) ?? [],
			consentRequests: this.consentRequests.map((request) => ({ ...request })),
			approvalRequests: this.approvalRequests.map((request) => ({ ...request, risks: [...request.risks] })),
			runtimeTools: { ...this.runtimeToolSet, toolNames: [...this.runtimeToolSet.toolNames] },
			settings: { ...this.settings, skillDirectories: [...this.settings.skillDirectories] },
			diagnostics: this.diagnostics.map((diagnostic) => ({ ...diagnostic })),
			performance: this.performance.all(),
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
			case "projects.addFromFolder": {
				const rootPath = await this.requireFolderPicker().selectProjectFolder();
				return rootPath ? this.addProject(rootPath) : null;
			}
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
				return this.listConversationPage(command.projectId, command.limit, command.cursor);
			case "sessions.listAll":
				return this.listAllConversations();
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
				return this.listMessagePage(command.limit, command.cursor);
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
				return this.skillInstallations.length > 0
					? this.skillInstallations
					: this.commands.filter((command) => command.source === "skill");
			case "skills.reload":
				return this.reloadSkills();
			case "skills.inspect":
				return this.inspectSkill(command.source);
			case "skills.install":
				return this.installSkill(command.source, command.scope, command.operationId);
			case "skills.import":
				return this.importSkill(command.path, command.scope, command.operationId);
			case "skills.remove":
				return this.removeSkill(command.installationId, command.operationId);
			case "skills.update":
				return this.updateSkill(command.installationId, command.operationId);
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
			case "mcp.retry":
				return this.retryMcpServer(command.serverId);
			case "mcp.testAndSave":
				return this.testAndSaveMcp(command.profile);
			case "mcp.import":
				return this.importMcp(command.json, command.scope);
			case "mcp.inspect":
				return this.inspectMcp(command.source);
			case "mcp.listTools":
				return this.options.mcp?.listTools(command.projectId ?? this.activeProjectId ?? undefined) ?? [];
			case "mcp.consent.respond":
				if (!this.options.mcp?.respondConsent?.(command.requestId, command.approved, command.scope))
					throw new DesktopError("NOT_FOUND", "Consent request is no longer pending", {
						requestId: command.requestId,
					});
				return true;
			case "mcp.consent.revoke":
				this.options.mcp?.revokeConsent?.(command.projectId, command.toolName);
				return true;
			case "approval.respond":
				if (!this.respondApproval(command.requestId, command.approved))
					throw new DesktopError("NOT_FOUND", "Approval request is no longer pending", {
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
		for (const requestId of [...this.pendingApprovals.keys()]) this.resolveApproval(requestId, false);
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

	private async listConversationPage(
		projectId: string,
		limit?: number,
		cursor?: string,
	): Promise<ConversationIndex[] | { items: ConversationIndex[]; nextCursor: string | null }> {
		if ((limit !== undefined || cursor !== undefined) && this.options.metadata.listConversationPage) {
			return this.options.metadata.listConversationPage(projectId, Math.max(1, Math.min(200, limit ?? 50)), cursor);
		}
		const conversations = await this.options.metadata.listConversations(projectId);
		if (limit === undefined && cursor === undefined) return conversations;
		const safeLimit = Math.max(1, Math.min(200, limit ?? 50));
		const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
		const items = conversations.slice(start, start + safeLimit);
		return { items, nextCursor: start + items.length < conversations.length ? String(start + items.length) : null };
	}

	private async listAllConversations(): Promise<Record<string, ConversationIndex[]>> {
		const startedAt = performance.now();
		const projects = this.projects;
		const indexed = this.options.metadata.listAllConversations
			? await this.options.metadata.listAllConversations()
			: (
					await Promise.all(
						projects.map(
							async (project) =>
								[project.id, await this.options.metadata.listConversations(project.id)] as const,
						),
					)
				).reduce<Record<string, ConversationIndex[]>>((result, [projectId, conversations]) => {
					result[projectId] = conversations;
					return result;
				}, {});
		if (!this.activeProjectId) {
			this.performance.record("sessions.bulk-list", startedAt);
			return indexed;
		}
		indexed[this.activeProjectId] = this.conversations.map((conversation) => ({ ...conversation }));
		this.performance.record("sessions.bulk-list", startedAt);
		return indexed;
	}

	private listMessagePage(
		limit?: number,
		cursor?: string,
	): DesktopMessage[] | { items: DesktopMessage[]; nextCursor: string | null } {
		const messages = collapseMessages([...this.messages.values()]);
		if (limit === undefined && cursor === undefined) return messages;
		const safeLimit = Math.max(1, Math.min(200, limit ?? 50));
		const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
		const items = messages.slice(start, start + safeLimit);
		return { items, nextCursor: start + items.length < messages.length ? String(start + items.length) : null };
	}

	private async startRuntime(project: Project, session?: ConversationIndex): Promise<void> {
		const startedAt = performance.now();
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
			if (this.skillService) {
				this.skillInstallations = await this.skillService.reconcile(this.commands);
				this.emit({ type: "skills.catalogChanged", installations: this.skillInstallations });
			}
			await this.applyRuntimeTools();
			const sessionPath = state.sessionPath ?? state.sessionRef;
			const providerId = state.providerId ?? this.options.runtimeProviderId ?? "pi";
			if (
				session &&
				(sessionPath !== session.sessionPath ||
					session.runtimeProviderId !== providerId ||
					session.modelProvider !== state.modelProvider ||
					session.modelId !== state.modelId)
			) {
				const updated = {
					...session,
					...(sessionPath ? { sessionPath } : {}),
					runtimeProviderId: providerId,
					runtimeSessionRef: state.sessionRef ?? sessionPath ?? session.runtimeSessionRef ?? null,
					sessionCodecId: session.sessionCodecId ?? (providerId === "pi" ? "pi-jsonl" : undefined),
					sessionFormatVersion: session.sessionFormatVersion ?? (providerId === "pi" ? 3 : null),
					modelProvider: state.modelProvider,
					modelId: state.modelId,
					updatedAt: now(),
				};
				if (this.draftSession?.id === session.id) this.draftSession = updated;
				else {
					await this.options.metadata.saveConversation(updated);
					this.conversations = await this.options.metadata.listConversations(project.id);
				}
			}
			this.emit({ type: "runtime.ready", projectId: project.id, sessionId, runtimeId, snapshot: this.runtime });
			this.performance.record("runtime.start", startedAt);
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
		await this.options.skillPackage?.setContext?.({
			cwd: project.rootPath,
			projectTrusted: project.trustState === "trusted",
		});
		const models: RuntimeModel[] = await this.modelGateway.resolveEnabled(this.models);
		const env: Record<string, string> = {};
		const sensitiveValues: string[] = [];
		for (const profile of this.models.filter((candidate) => candidate.enabled)) {
			const apiKey = models.find(
				(model) => model.providerId === profile.providerId && model.modelId === profile.modelId,
			)?.apiKey;
			if (profile.credentialRef && !apiKey)
				this.recordDiagnostic("warning", "credentials", `Credential for ${profile.displayName} is unavailable`);
		}
		const defaultProfile = this.models.find(
			(candidate) => candidate.id === this.settings.defaultModelProfileId && candidate.enabled,
		);
		const sessionProfile =
			session?.modelProvider && session.modelId
				? this.models.find(
						(candidate) =>
							candidate.enabled &&
							candidate.providerId === session.modelProvider &&
							candidate.modelId === session.modelId,
					)
				: undefined;
		const selectedModel =
			(sessionProfile ? { providerId: sessionProfile.providerId, modelId: sessionProfile.modelId } : undefined) ??
			(defaultProfile ? { providerId: defaultProfile.providerId, modelId: defaultProfile.modelId } : undefined);
		const activeProfile = selectedModel
			? this.models.find(
					(candidate) =>
						candidate.enabled &&
						candidate.providerId === selectedModel.providerId &&
						candidate.modelId === selectedModel.modelId,
				)
			: undefined;
		const activeIsDeepSeek = activeProfile !== undefined && isDeepSeekModel(activeProfile);
		const webSearchProvider = this.settings.webSearch.provider;
		const deepseekSearchEnabled =
			webSearchProvider === "deepseek" || (webSearchProvider === "disabled" && activeIsDeepSeek);
		const deepseekSearchProfile = deepseekSearchEnabled
			? activeIsDeepSeek
				? activeProfile
				: this.models.find((candidate) => candidate.enabled && isDeepSeekModel(candidate))
			: undefined;
		const deepseekSearchModel = deepseekSearchProfile
			? models.find(
					(model) =>
						model.providerId === deepseekSearchProfile.providerId &&
						model.modelId === deepseekSearchProfile.modelId,
				)
			: undefined;
		if (
			webSearchProvider !== "disabled" &&
			webSearchProvider !== "deepseek" &&
			this.settings.webSearch.credentialRef
		) {
			const apiKey = this.options.secrets
				? await this.options.secrets.get(this.settings.webSearch.credentialRef)
				: null;
			if (apiKey) {
				env[webSearchProvider === "brave" ? "BRAVE_SEARCH_API_KEY" : "TAVILY_API_KEY"] = apiKey;
				sensitiveValues.push(apiKey);
			} else {
				this.recordDiagnostic("warning", "web-search", "Web search credential is unavailable");
			}
		}
		if (deepseekSearchEnabled) {
			if (deepseekSearchProfile && deepseekSearchModel?.apiKey) {
				env.PI_DESKTOP_WEB_SEARCH_PROVIDER = "deepseek";
				env.PI_DESKTOP_WEB_SEARCH_DEEPSEEK_BASE_URL = deepseekSearchProfile.baseUrl.replace(/\/+$/, "");
				env.PI_DESKTOP_WEB_SEARCH_DEEPSEEK_MODEL = deepseekSearchProfile.modelId;
				env.PI_DESKTOP_WEB_SEARCH_DEEPSEEK_API_KEY = deepseekSearchModel.apiKey;
				sensitiveValues.push(deepseekSearchModel.apiKey);
			} else {
				this.recordDiagnostic(
					"warning",
					"web-search",
					"DeepSeek built-in search requires an enabled DeepSeek model with a stored API key",
				);
			}
		}
		const webSearchExtensionEnabled =
			webSearchProvider !== "disabled" || (webSearchProvider === "disabled" && activeIsDeepSeek);
		const skillDirectories = this.options.skillPackage?.runtimePaths
			? await this.options.skillPackage.runtimePaths()
			: [...this.settings.skillDirectories];
		return {
			cwd: project.rootPath,
			sessionRef: session?.sessionPath,
			sessionPath: session?.sessionPath,
			sessionDirectory: this.sessionDirectory(project),
			agentDirectory: this.agentDirectory(project),
			globalSystemPrompt: this.settings.globalSystemPrompt,
			projectTrusted: project.trustState === "trusted",
			skillDirectories,
			extensionPaths:
				webSearchExtensionEnabled && this.options.webSearchExtensionPath
					? [this.options.webSearchExtensionPath]
					: [],
			env,
			sensitiveValues,
			models,
			selectedModel,
			thinkingLevel: session?.thinkingLevel ?? this.settings.defaultThinkingLevel,
			runtimeId,
			providerId: this.options.runtimeProviderId ?? "pi",
			tools: this.runtimeToolDefinitions(project),
		};
	}

	private runtimeToolDefinitions(project?: Project) {
		return [
			...createDesktopManagementTools({
				skills: this.skillService,
				mcp: this.options.mcp,
				metadata: this.options.metadata,
				getProjectId: () => this.activeProjectId,
				approve: (request) => this.requestApproval(request),
				inspectMcp: (source) => this.inspectMcp(source),
				installMcp: (profile) => this.installMcpFromAgent(profile),
				updateMcp: (serverId, patch) => this.updateMcpServer(serverId, patch),
				removeMcp: (serverId) => this.deleteMcpServer(serverId),
			}),
			...(this.options.mcp?.listToolDefinitions?.(
				this.activeProjectId ?? undefined,
				project?.trustState === "trusted",
			) ?? []),
		];
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
		if (this.runtime.status !== "ready" && this.runtime.status !== "streaming")
			throw new DesktopError("NOT_READY", this.runtime.lastError ?? "Runtime is not ready");
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
		const state = await this.requireRuntime().getState();
		const effective = state.thinkingLevel ?? level;
		if (this.runtime) {
			this.runtime.thinkingLevel = effective;
			if (state.availableThinkingLevels) this.runtime.availableThinkingLevels = state.availableThinkingLevels;
		}
		await this.updateActiveConversation({ thinkingLevel: effective });
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
		const skillDirectoriesChanged =
			JSON.stringify(next.skillDirectories) !== JSON.stringify(this.settings.skillDirectories);
		this.settings = next;
		if (skillDirectoriesChanged) {
			if (this.runtime) await this.restartActiveRuntime("skill directories changed");
			if (this.skillService) {
				this.skillInstallations = await this.skillService.reconcile(this.commands);
				this.emit({ type: "skills.catalogChanged", installations: this.skillInstallations });
			}
		}
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
		if (provider !== "deepseek" && apiKey?.trim()) {
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
		if (input.protocol && !["openai-compatible", "anthropic", "local", "custom"].includes(input.protocol))
			throw new DesktopError("INVALID_ARGUMENT", "Model protocol is invalid");
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
			protocol: patch.protocol ?? profile.protocol,
			capabilities: patch.capabilities ?? profile.capabilities,
			credentialStrategy: patch.credentialStrategy ?? profile.credentialStrategy,
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
		if (this.skillService) {
			this.skillInstallations = await this.skillService.reconcile(this.commands);
			this.emit({ type: "skills.catalogChanged", installations: this.skillInstallations });
		}
		return this.commands.filter((command) => command.source === "skill");
	}

	private async applyRuntimeTools(): Promise<void> {
		if (!this.runtimePort.setTools) return;
		const project = this.projects.find((candidate) => candidate.id === this.activeProjectId);
		const definitions = this.runtimeToolDefinitions(project);
		const generation = this.runtimeToolSet.desiredGeneration + 1;
		this.runtimeToolSet = {
			desiredGeneration: generation,
			appliedGeneration: null,
			toolNames: definitions.map((tool) => tool.name),
			lastError: null,
		};
		this.emit({
			type: "runtime.toolsChanged",
			snapshot: { ...this.runtimeToolSet, toolNames: [...this.runtimeToolSet.toolNames] },
		});
		try {
			await this.runtimePort.setTools(definitions);
			this.runtimeToolSet = { ...this.runtimeToolSet, appliedGeneration: generation };
			this.emit({
				type: "runtime.toolsChanged",
				snapshot: { ...this.runtimeToolSet, toolNames: [...this.runtimeToolSet.toolNames] },
			});
			if (this.options.mcp) {
				this.mcpServers = this.mcpServers.map((server) => ({
					...server,
					agentAvailability: server.toolCount > 0 ? "available" : "unknown",
					agentToolGeneration: generation,
				}));
				for (const server of this.mcpServers)
					this.emit({
						type: "mcp.agentAvailabilityChanged",
						serverId: server.profile.id,
						availability: server.agentAvailability ?? "unknown",
						toolGeneration: generation,
					});
			}
		} catch (error) {
			this.runtimeToolSet = {
				...this.runtimeToolSet,
				lastError: error instanceof Error ? error.message : String(error),
			};
			this.emit({
				type: "runtime.toolsChanged",
				snapshot: { ...this.runtimeToolSet, toolNames: [...this.runtimeToolSet.toolNames] },
			});
		}
	}

	private async inspectSkill(source: SkillSource) {
		if (!this.skillService) throw new DesktopError("NOT_SUPPORTED", "Skill package management is unavailable");
		return this.skillService.inspect(source, "global");
	}

	private async installSkill(source: SkillSource, scope: SkillInstallScope = "global", operationId?: string) {
		if (!this.skillService) throw new DesktopError("NOT_SUPPORTED", "Skill package management is unavailable");
		const installation = await this.skillService.install(source, scope, operationId);
		this.skillInstallations = await this.skillService.list();
		this.emit({ type: "skills.catalogChanged", installations: this.skillInstallations });
		return installation;
	}

	private async importSkill(path: string, scope: SkillInstallScope = "global", operationId?: string) {
		return this.installSkill({ kind: "local", spec: path }, scope, operationId);
	}

	private async removeSkill(installationId: string, operationId?: string): Promise<null> {
		if (!this.skillService) throw new DesktopError("NOT_SUPPORTED", "Skill package management is unavailable");
		const installation = this.skillInstallations.find((item) => item.id === installationId);
		if (!installation) throw new DesktopError("NOT_FOUND", "Skill installation not found", { installationId });
		await this.skillService.remove(installation, operationId);
		this.skillInstallations = await this.skillService.list();
		this.emit({ type: "skills.catalogChanged", installations: this.skillInstallations });
		return null;
	}

	private async updateSkill(installationId: string, operationId?: string) {
		const installation = this.skillInstallations.find((item) => item.id === installationId);
		if (!installation) throw new DesktopError("NOT_FOUND", "Skill installation not found", { installationId });
		return this.installSkill(installation.source, installation.scope, operationId);
	}

	private async reconcileMcp(): Promise<void> {
		if (!this.options.mcp) return;
		for (const profile of this.mcpProfiles) {
			if (!profile.enabled || (profile.projectId !== null && profile.projectId !== this.activeProjectId)) {
				await this.options.mcp.stop(profile.id, "project scope changed");
				continue;
			}
			const snapshot = await this.options.mcp.start(profile);
			await this.persistResolvedMcpVersion(profile, snapshot);
			this.mcpServers = this.options.mcp.list();
			if (snapshot.status === "error")
				this.recordDiagnostic("error", "mcp", snapshot.lastError ?? "MCP server failed");
		}
		this.mcpServers = this.options.mcp.list();
	}

	private async createMcpServer(input: McpServerDraft, profileId: string = randomUUID()): Promise<McpServerSnapshot> {
		if (!this.options.mcp) throw new DesktopError("NOT_SUPPORTED", "MCP is unavailable");
		const profile: McpServerProfile = { ...input, id: profileId, args: [...input.args], env: { ...input.env } };
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
		await this.persistResolvedMcpVersion(profile, snapshot);
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
		await this.persistResolvedMcpVersion(updated, snapshot);
		this.mcpServers = this.options.mcp?.list() ?? [];
		return publicMcpSnapshot(snapshot);
	}

	private async deleteMcpServer(serverId: string): Promise<null> {
		if (!this.mcpProfiles.some((profile) => profile.id === serverId))
			throw new DesktopError("NOT_FOUND", "MCP server not found", { serverId });
		await this.options.mcp?.stop(serverId, "server deleted");
		await this.options.mcp?.removeManagedPackage?.(serverId);
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

	private async retryMcpServer(serverId: string): Promise<McpServerSnapshot> {
		const profile = this.mcpProfiles.find((candidate) => candidate.id === serverId);
		if (!profile || !this.options.mcp) throw new DesktopError("NOT_FOUND", "MCP server not found", { serverId });
		const snapshot = await this.options.mcp.start(profile);
		await this.persistResolvedMcpVersion(profile, snapshot);
		this.mcpServers = this.options.mcp.list();
		return publicMcpSnapshot(snapshot);
	}

	private async testAndSaveMcp(profile: McpServerDraft): Promise<McpServerSnapshot> {
		if (!this.options.mcp) throw new DesktopError("NOT_SUPPORTED", "MCP is unavailable");
		const preview = { ...profile, id: randomUUID(), args: [...profile.args], env: { ...profile.env } };
		const tested = await this.options.mcp.test(preview);
		if (tested.status !== "ready") return publicMcpSnapshot(tested);
		return this.createMcpServer({
			...profile,
			packageVersion: tested.profile.packageVersion ?? profile.packageVersion,
		});
	}

	private async persistResolvedMcpVersion(profile: McpServerProfile, snapshot: McpServerSnapshot): Promise<void> {
		const resolvedVersion = snapshot.profile.packageVersion;
		const launchKind = profile.launchKind ?? (profile.command === "npx" ? "managed-npm" : undefined);
		if (launchKind !== "managed-npm" || !resolvedVersion || resolvedVersion === profile.packageVersion) return;
		const updated = { ...profile, packageVersion: resolvedVersion };
		await this.options.metadata.saveMcpServer(updated);
		this.mcpProfiles = this.mcpProfiles.map((candidate) => (candidate.id === profile.id ? updated : candidate));
	}

	private async inspectMcp(source: string): Promise<Record<string, unknown>> {
		const normalized = normalizeMcpProfileSource(source);
		return {
			source,
			normalized,
			risks:
				normalized.launchKind === "executable" ? ["Executes a local process"] : ["May download third-party code"],
		};
	}

	private async installMcpFromAgent(profile: McpServerDraft): Promise<McpServerSnapshot> {
		const profileId = randomUUID();
		try {
			const snapshot = await this.createMcpServer({ ...profile, enabled: true }, profileId);
			if (snapshot.status !== "ready")
				throw new DesktopError("PROCESS_ERROR", snapshot.lastError ?? "MCP server did not become ready");
			return snapshot;
		} catch (error) {
			if (this.mcpProfiles.some((candidate) => candidate.id === profileId)) await this.deleteMcpServer(profileId);
			throw error;
		}
	}

	private requestApproval(request: Omit<DesktopApprovalRequest, "requestId" | "createdAt">): Promise<boolean> {
		const fullRequest: DesktopApprovalRequest = {
			...request,
			requestId: randomUUID(),
			createdAt: now(),
			risks: [...request.risks],
		};
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => this.resolveApproval(fullRequest.requestId, false), 120_000);
			this.pendingApprovals.set(fullRequest.requestId, { resolve, timer });
			this.approvalRequests.push(fullRequest);
			this.emit({ type: "approval.required", request: { ...fullRequest, risks: [...fullRequest.risks] } });
		});
	}

	private respondApproval(requestId: string, approved: boolean): boolean {
		if (!this.pendingApprovals.has(requestId)) return false;
		this.resolveApproval(requestId, approved);
		return true;
	}

	private resolveApproval(requestId: string, approved: boolean): void {
		const pending = this.pendingApprovals.get(requestId);
		if (!pending) return;
		this.pendingApprovals.delete(requestId);
		clearTimeout(pending.timer);
		this.approvalRequests = this.approvalRequests.filter((request) => request.requestId !== requestId);
		pending.resolve(approved);
		this.emit({ type: "approval.resolved", requestId, approved });
	}

	private async importMcp(json: string, scope: "global" | "project" = "project"): Promise<McpServerSnapshot[]> {
		const parsed = JSON.parse(json) as { mcpServers?: Record<string, Record<string, unknown>> };
		if (!parsed.mcpServers || typeof parsed.mcpServers !== "object")
			throw new DesktopError("INVALID_ARGUMENT", "MCP JSON must contain mcpServers");
		const result: McpServerSnapshot[] = [];
		for (const [name, value] of Object.entries(parsed.mcpServers)) {
			let profile: McpServerDraft = normalizeMcpProfileSource(JSON.stringify({ name, ...value }));
			profile = await this.protectImportedMcpSecrets(profile, value);
			result.push(
				await this.createMcpServer({
					...profile,
					projectId: scope === "project" ? this.activeProjectId : null,
					scope,
				}),
			);
		}
		return result;
	}

	private async protectImportedMcpSecrets(
		profile: McpServerDraft,
		input: Record<string, unknown>,
	): Promise<McpServerDraft> {
		const env =
			typeof input.env === "object" && input.env !== null
				? Object.fromEntries(
						Object.entries(input.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
					)
				: {};
		const headers =
			typeof input.headers === "object" && input.headers !== null
				? Object.fromEntries(
						Object.entries(input.headers).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					)
				: {};
		if ((Object.keys(env).length > 0 || Object.keys(headers).length > 0) && !this.options.secrets)
			throw new DesktopError("NOT_SUPPORTED", "Secret storage is required to import MCP environment or headers");
		const secretEnvRefs = { ...(profile.secretEnvRefs ?? {}) };
		const secretHeaderRefs = { ...(profile.secretHeaderRefs ?? {}) };
		for (const [name, value] of Object.entries(env))
			secretEnvRefs[name] = await (this.options.secrets as SecretStore).set(value);
		for (const [name, value] of Object.entries(headers))
			secretHeaderRefs[name] = await (this.options.secrets as SecretStore).set(value);
		return { ...profile, env: {}, secretEnvRefs, secretHeaderRefs };
	}

	/**
	 * Pi only serves the in-memory agent context via get_messages. Long sessions
	 * are compacted (the transcript collapses into a summary), so after a session
	 * reload the runtime alone would hide almost the entire conversation.
	 * The session JSONL is the durable transcript, so merge it back in: the full
	 * file history is shown in order, with runtime copies winning where they
	 * match (live status/durations), and any live-only tail appended last.
	 */
	private async mergeSessionTranscript(runtimeMessages: DesktopMessage[]): Promise<DesktopMessage[]> {
		const sessionFiles = this.options.sessionFiles;
		const session = this.activeConversation();
		if (!sessionFiles?.readMessages || !session?.sessionPath) return runtimeMessages;
		let fileMessages: DesktopMessage[];
		try {
			fileMessages = collapseMessages(await sessionFiles.readMessages(session.sessionPath));
		} catch (_error: unknown) {
			this.recordDiagnostic("warning", "session-index", `Session transcript read failed: ${session.sessionPath}`);
			return runtimeMessages;
		}
		if (fileMessages.length === 0) return runtimeMessages;
		const runtimeByIdentity = new Map<string, DesktopMessage>();
		for (const message of runtimeMessages) {
			const key = messageFingerprint(message);
			if (!runtimeByIdentity.has(key)) runtimeByIdentity.set(key, message);
		}
		const merged: DesktopMessage[] = [];
		for (const message of fileMessages) {
			const live = runtimeByIdentity.get(messageFingerprint(message));
			if (live) {
				runtimeByIdentity.delete(messageFingerprint(message));
				merged.push(cloneMessage(live));
			} else merged.push(cloneMessage(message));
		}
		for (const message of runtimeMessages) {
			const key = messageFingerprint(message);
			if (!runtimeByIdentity.has(key)) continue;
			runtimeByIdentity.delete(key);
			// Pi compaction summaries normalize to empty tool parts; they are not
			// part of the visible transcript, so do not surface them as a message.
			if (message.role === "tool" && !hasVisibleMessageContent(message)) continue;
			merged.push(cloneMessage(message));
		}
		return merged;
	}

	private async refreshRuntimeMessages(): Promise<void> {
		const startedAt = performance.now();
		const previousMessages = collapseMessages([...this.messages.values()]);
		const previous = new Map(previousMessages.map((message) => [message.id, message]));
		const runtimeMessages = collapseMessages(await this.requireRuntime().getMessages());
		const messages = await this.mergeSessionTranscript(runtimeMessages);
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
		this.performance.record("session.messages-read", startedAt);
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
			this.emit({ type: "mcp.connectionChanged", server: publicSnapshot });
		} else if (event.serverId) {
			const snapshot = this.mcpServers.find((candidate) => candidate.profile.id === event.serverId);
			if (snapshot) {
				const publicSnapshot = publicMcpSnapshot(snapshot);
				this.emit({ type: "mcp.serverChanged", server: publicSnapshot });
				this.emit({ type: "mcp.connectionChanged", server: publicSnapshot });
			}
		}
		if (event.tools) {
			const tools = event.tools.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
			this.emit({ type: "mcp.toolsChanged", tools });
			void this.applyRuntimeTools();
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
