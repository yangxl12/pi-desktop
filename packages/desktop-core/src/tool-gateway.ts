import type { ToolDescriptor } from "@earendil-works/pi-desktop-protocol";

export interface ToolContext {
	projectId: string | null;
	sessionId?: string | null;
	trusted: boolean;
	signal?: AbortSignal;
}

export interface ToolCallResult {
	content: Array<Record<string, unknown>>;
	isError?: boolean;
}

export type ToolGatewayEvent =
	| { type: "tools.changed"; tools: ToolDescriptor[] }
	| { type: "consent.required"; requestId: string; toolName: string; projectId: string | null }
	| { type: "tool.started"; requestId: string; toolName: string }
	| { type: "tool.finished"; requestId: string; toolName: string; failed: boolean };

export interface ToolGateway {
	list(context: Pick<ToolContext, "projectId">): ToolDescriptor[];
	call(name: string, argumentsValue: Record<string, unknown>, context: ToolContext): Promise<ToolCallResult>;
	subscribe(listener: (event: ToolGatewayEvent) => void): () => void;
}
