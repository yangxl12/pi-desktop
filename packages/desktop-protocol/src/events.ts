import type {
	DesktopMessage,
	Diagnostic,
	McpConsentRequest,
	McpServerSnapshot,
	McpTool,
	RuntimeIdentity,
	RuntimeSnapshot,
	SkillCommand,
	WindowState,
} from "./types.ts";

export type DesktopEvent =
	| ({ type: "window.changed" } & WindowState)
	| ({ type: "runtime.started" } & RuntimeIdentity)
	| ({ type: "runtime.ready"; snapshot: RuntimeSnapshot } & RuntimeIdentity)
	| ({ type: "runtime.stopped"; reason?: string } & RuntimeIdentity)
	| ({ type: "runtime.error"; error: string } & RuntimeIdentity)
	| ({ type: "session.changed"; sessionId: string; projectId: string } & RuntimeIdentity)
	| ({ type: "message.started"; message: DesktopMessage } & RuntimeIdentity)
	| ({ type: "message.delta"; messageId: string; part: "text" | "thinking"; delta: string } & RuntimeIdentity)
	| ({ type: "message.finished"; message: DesktopMessage } & RuntimeIdentity)
	| ({ type: "message.aborted"; messageId?: string } & RuntimeIdentity)
	| ({ type: "tool.started"; messageId: string; toolName: string; toolCallId: string } & RuntimeIdentity)
	| ({ type: "tool.update"; messageId: string; toolCallId: string; text: string } & RuntimeIdentity)
	| ({ type: "tool.finished"; messageId: string; toolCallId: string; text: string; failed: boolean } & RuntimeIdentity)
	| ({ type: "skills.changed"; commands: SkillCommand[] } & RuntimeIdentity)
	| { type: "mcp.serverChanged"; server: McpServerSnapshot }
	| { type: "mcp.toolsChanged"; tools: McpTool[] }
	| { type: "mcp.consentRequired"; request: McpConsentRequest }
	| { type: "mcp.consentResolved"; requestId: string; approved: boolean }
	| ({ type: "diagnostic"; diagnostic: Diagnostic } & RuntimeIdentity);

export type DesktopEventListener = (event: DesktopEvent) => void;
