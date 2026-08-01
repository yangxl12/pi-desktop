import type { McpManager } from "./manager.ts";
import type { McpTool } from "./types.ts";

export interface PiMcpToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	call: (
		argumentsValue: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>;
}

export function createPiMcpTools(
	manager: McpManager,
	context: () => { projectId: string | null; trusted: boolean },
): PiMcpToolDefinition[] {
	return manager.listTools(context().projectId ?? undefined).map((tool: McpTool) => ({
		name: tool.namespacedName.replace(/[^a-zA-Z0-9_-]/g, "_"),
		description: tool.description ?? `MCP tool ${tool.namespacedName}`,
		parameters: tool.inputSchema,
		call: (argumentsValue, signal) => manager.callTool(tool.namespacedName, argumentsValue, { ...context(), signal }),
	}));
}
