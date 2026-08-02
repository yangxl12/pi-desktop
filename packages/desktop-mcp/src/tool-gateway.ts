import type { ToolCallResult, ToolContext, ToolGateway, ToolGatewayEvent } from "@earendil-works/pi-desktop-core";
import type { ToolDescriptor } from "@earendil-works/pi-desktop-protocol";
import type { McpManager } from "./manager.ts";

export class McpToolGateway implements ToolGateway {
	private readonly listeners = new Set<(event: ToolGatewayEvent) => void>();
	private readonly unsubscribe: () => void;
	private readonly manager: McpManager;

	constructor(manager: McpManager) {
		this.manager = manager;
		this.unsubscribe = manager.subscribe((event) => {
			if (event.type === "tools.changed")
				this.emit({ type: "tools.changed", tools: event.tools.map((tool) => this.describe(tool)) });
			if (event.type === "tool.started")
				this.emit({ type: "tool.started", requestId: event.requestId, toolName: event.toolName });
			if (event.type === "tool.finished")
				this.emit({
					type: "tool.finished",
					requestId: event.requestId,
					toolName: event.toolName,
					failed: event.failed,
				});
		});
	}

	list(context: Pick<ToolContext, "projectId">): ToolDescriptor[] {
		return this.manager.listTools(context.projectId ?? undefined).map((tool) => this.describe(tool));
	}

	call(name: string, argumentsValue: Record<string, unknown>, context: ToolContext): Promise<ToolCallResult> {
		return this.manager.callTool(name, argumentsValue, context);
	}

	subscribe(listener: (event: ToolGatewayEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.unsubscribe();
		this.listeners.clear();
	}

	private describe(tool: {
		name: string;
		description?: string;
		inputSchema: Record<string, unknown>;
		serverId: string;
		namespacedName: string;
	}): ToolDescriptor {
		return {
			name: tool.namespacedName,
			namespace: tool.namespacedName.split(".", 1)[0],
			description: tool.description,
			inputSchema: { ...tool.inputSchema },
			source: "mcp",
			trustRequirement: "trusted-project",
			consentRequirement: "untrusted-project",
			projectScope: null,
		};
	}

	private emit(event: ToolGatewayEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
