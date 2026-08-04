import type {
	AppSettings,
	ConversationIndex,
	DesktopErrorShape,
	DesktopMessage,
	DesktopState,
	McpServerDraft,
	McpServerPatch,
	McpServerSnapshot,
	McpTool,
	ModelConnectionResult,
	ModelProfile,
	ModelProfileDraft,
	ModelProfilePatch,
	Project,
	QueueMode,
	SkillCommand,
	ThinkingLevel,
	TrustState,
	WebSearchProvider,
} from "./types.ts";

export type DesktopCommandBase =
	| { type: "window.show" }
	| { type: "window.hide" }
	| { type: "window.toggle" }
	| { type: "window.minimize" }
	| { type: "window.maximize" }
	| { type: "window.closeToTray" }
	| { type: "app.quit" }
	| { type: "app.getState" }
	| { type: "app.getDiagnostics" }
	| { type: "app.exportDiagnostics" }
	| { type: "projects.list" }
	| { type: "projects.addFromFolder" }
	| { type: "projects.add"; rootPath: string; name?: string }
	| { type: "projects.select"; projectId: string }
	| { type: "projects.rename"; projectId: string; name: string }
	| { type: "projects.setTrust"; projectId: string; trustState: TrustState }
	| { type: "projects.remove"; projectId: string }
	| { type: "sessions.list"; projectId: string; limit?: number; cursor?: string }
	| { type: "sessions.listAll" }
	| { type: "sessions.create"; projectId: string; title?: string }
	| { type: "sessions.open"; sessionId: string }
	| { type: "sessions.rename"; sessionId: string; title: string }
	| { type: "sessions.refresh"; sessionId: string }
	| { type: "sessions.rebuild"; projectId: string }
	| { type: "agent.getState" }
	| { type: "agent.getMessages"; limit?: number; cursor?: string }
	| { type: "agent.prompt"; text: string; queueMode?: QueueMode }
	| { type: "agent.retryLast" }
	| { type: "agent.abort" }
	| { type: "agent.setThinkingLevel"; level: ThinkingLevel }
	| { type: "agent.setModel"; profileId: string }
	| { type: "agent.getCommands" }
	| { type: "settings.get" }
	| { type: "settings.update"; patch: Partial<AppSettings> }
	| { type: "settings.reset"; key: keyof AppSettings }
	| { type: "webSearch.update"; provider: WebSearchProvider; apiKey?: string; clearCredential?: boolean }
	| { type: "models.list" }
	| { type: "models.create"; profile: ModelProfileDraft; apiKey?: string }
	| { type: "models.update"; profileId: string; patch: ModelProfilePatch; apiKey?: string; clearCredential?: boolean }
	| { type: "models.delete"; profileId: string }
	| { type: "models.testConnection"; profileId: string }
	| { type: "models.setDefault"; profileId: string | null }
	| { type: "skills.list" }
	| { type: "skills.reload" };

export type DesktopMcpCommand =
	| { type: "mcp.list" }
	| { type: "mcp.create"; profile: McpServerDraft }
	| { type: "mcp.update"; serverId: string; patch: McpServerPatch }
	| { type: "mcp.delete"; serverId: string }
	| { type: "mcp.setEnabled"; serverId: string; enabled: boolean }
	| { type: "mcp.testConnection"; serverId: string }
	| { type: "mcp.listTools"; projectId?: string }
	| { type: "mcp.consent.respond"; requestId: string; approved: boolean; scope?: "once" | "session" | "project" };

export type DesktopCommand = DesktopCommandBase | DesktopMcpCommand;

export interface DesktopRequest<T extends DesktopCommand = DesktopCommand> {
	requestId: string;
	command: T;
}

export interface DesktopResponse<T = unknown> {
	requestId: string;
	success: boolean;
	data?: T;
	error?: DesktopErrorShape;
}

export type DesktopCommandResult =
	| DesktopState
	| Project[]
	| Project
	| ConversationIndex[]
	| import("./types.ts").ConversationPage
	| Record<string, ConversationIndex[]>
	| ConversationIndex
	| DesktopMessage[]
	| import("./types.ts").MessagePage
	| ModelProfile[]
	| ModelProfile
	| ModelConnectionResult
	| AppSettings
	| SkillCommand[]
	| McpServerSnapshot[]
	| McpServerSnapshot
	| McpTool[]
	| boolean
	| null
	| { commands: Array<{ name: string; description?: string; source: string }> };
