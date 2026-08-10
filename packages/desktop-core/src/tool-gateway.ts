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

/** Combines multiple providers while preserving provider-owned policy/callbacks. */
export class CompositeToolGateway implements ToolGateway {
	private readonly gateways: ToolGateway[];
	private readonly listeners = new Set<(event: ToolGatewayEvent) => void>();
	private readonly unsubscribers: Array<() => void>;

	constructor(gateways: readonly ToolGateway[] = []) {
		this.gateways = [...gateways];
		this.unsubscribers = this.gateways.map((gateway) => gateway.subscribe((event) => this.emit(event)));
	}

	list(context: Pick<ToolContext, "projectId">): ToolDescriptor[] {
		const result: ToolDescriptor[] = [];
		const names = new Set<string>();
		for (const gateway of this.gateways) {
			for (const descriptor of gateway.list(context)) {
				if (names.has(descriptor.name)) continue;
				names.add(descriptor.name);
				result.push({ ...descriptor, inputSchema: { ...descriptor.inputSchema } });
			}
		}
		return result;
	}

	async call(name: string, argumentsValue: Record<string, unknown>, context: ToolContext): Promise<ToolCallResult> {
		for (const gateway of this.gateways) {
			if (gateway.list({ projectId: context.projectId }).some((descriptor) => descriptor.name === name))
				return gateway.call(name, argumentsValue, context);
		}
		throw new Error(`Tool not found: ${name}`);
	}

	subscribe(listener: (event: ToolGatewayEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		for (const unsubscribe of this.unsubscribers) unsubscribe();
		this.listeners.clear();
	}

	private emit(event: ToolGatewayEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
