import { randomUUID } from "node:crypto";
import type { McpConsentRequest } from "@earendil-works/pi-desktop-protocol";

export type ConsentScope = "once" | "session" | "project";
export type ToolPolicyDecision = "allow" | "deny";

export interface ToolPolicyStore {
	get(projectId: string | null, toolName: string): ToolPolicyDecision | null;
	set(
		projectId: string | null,
		toolName: string,
		decision: ToolPolicyDecision,
		scope: Exclude<ConsentScope, "once">,
	): void;
	revoke(projectId?: string | null, toolName?: string): void;
}

export class InMemoryToolPolicyStore implements ToolPolicyStore {
	private readonly policies = new Map<string, ToolPolicyDecision>();

	get(projectId: string | null, toolName: string): ToolPolicyDecision | null {
		return this.policies.get(`${projectId ?? "*"}:${toolName}`) ?? this.policies.get(`*:${toolName}`) ?? null;
	}

	set(
		projectId: string | null,
		toolName: string,
		decision: ToolPolicyDecision,
		scope: Exclude<ConsentScope, "once">,
	): void {
		this.policies.set(`${scope === "project" ? (projectId ?? "*") : "*"}:${toolName}`, decision);
	}

	revoke(projectId?: string | null, toolName?: string): void {
		for (const key of this.policies.keys()) {
			const [storedProject, storedTool] = key.split(":");
			if (
				(projectId === undefined || storedProject === (projectId ?? "*")) &&
				(toolName === undefined || storedTool === toolName)
			)
				this.policies.delete(key);
		}
	}
}

export type ConsentBrokerEvent =
	| { type: "consent.required"; request: McpConsentRequest }
	| { type: "consent.resolved"; requestId: string; approved: boolean };

interface PendingConsent {
	request: McpConsentRequest;
	resolve: (approved: boolean) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Host-owned consent broker. No UI response or prompt means default deny. */
export class ConsentBroker {
	private readonly store: ToolPolicyStore;
	private readonly timeoutMs: number;
	private readonly pending = new Map<string, PendingConsent>();
	private readonly listeners = new Set<(event: ConsentBrokerEvent) => void>();

	constructor(options: { store?: ToolPolicyStore; timeoutMs?: number } = {}) {
		this.store = options.store ?? new InMemoryToolPolicyStore();
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	subscribe(listener: (event: ConsentBrokerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	request(request: Omit<McpConsentRequest, "requestId"> & { requestId?: string }): Promise<boolean> {
		const fullRequest: McpConsentRequest = { ...request, requestId: request.requestId ?? randomUUID() };
		const stored = this.store.get(fullRequest.projectId, `${fullRequest.serverId}.${fullRequest.toolName}`);
		if (stored) return Promise.resolve(stored === "allow");
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(fullRequest.requestId);
				resolve(false);
				this.emit({ type: "consent.resolved", requestId: fullRequest.requestId, approved: false });
			}, this.timeoutMs);
			this.pending.set(fullRequest.requestId, { request: fullRequest, resolve, timer });
			this.emit({ type: "consent.required", request: fullRequest });
		});
	}

	respond(requestId: string, approved: boolean, scope: ConsentScope = "once"): boolean {
		const pending = this.pending.get(requestId);
		if (!pending) return false;
		clearTimeout(pending.timer);
		this.pending.delete(requestId);
		if (scope !== "once")
			this.store.set(
				pending.request.projectId,
				`${pending.request.serverId}.${pending.request.toolName}`,
				approved ? "allow" : "deny",
				scope,
			);
		pending.resolve(approved);
		this.emit({ type: "consent.resolved", requestId, approved });
		return true;
	}

	private emit(event: ConsentBrokerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
