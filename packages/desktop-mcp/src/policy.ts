import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

function policyKey(projectId: string | null, toolName: string): string {
	return JSON.stringify([projectId, toolName]);
}

/** Persists project grants while keeping session grants process-local. */
export class FileToolPolicyStore implements ToolPolicyStore {
	private readonly sessionPolicies = new Map<string, ToolPolicyDecision>();
	private readonly projectPolicies = new Map<string, ToolPolicyDecision>();
	private readonly path: string;

	constructor(path: string) {
		this.path = path;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				version?: number;
				policies?: Record<string, ToolPolicyDecision>;
			};
			if (parsed.version === 1)
				for (const [key, decision] of Object.entries(parsed.policies ?? {}))
					if (decision === "allow" || decision === "deny") this.projectPolicies.set(key, decision);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	get(projectId: string | null, toolName: string): ToolPolicyDecision | null {
		const key = policyKey(projectId, toolName);
		return this.sessionPolicies.get(key) ?? this.projectPolicies.get(key) ?? null;
	}

	set(
		projectId: string | null,
		toolName: string,
		decision: ToolPolicyDecision,
		scope: Exclude<ConsentScope, "once">,
	): void {
		const policies = scope === "session" ? this.sessionPolicies : this.projectPolicies;
		policies.set(policyKey(projectId, toolName), decision);
		if (scope === "project") this.persist();
	}

	revoke(projectId?: string | null, toolName?: string): void {
		let projectChanged = false;
		for (const policies of [this.sessionPolicies, this.projectPolicies]) {
			for (const key of policies.keys()) {
				const [storedProject, storedTool] = JSON.parse(key) as [string | null, string];
				if (
					(projectId === undefined || storedProject === projectId) &&
					(toolName === undefined || storedTool === toolName)
				) {
					policies.delete(key);
					if (policies === this.projectPolicies) projectChanged = true;
				}
			}
		}
		if (projectChanged) this.persist();
	}

	private persist(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.tmp`;
		writeFileSync(
			temporary,
			JSON.stringify({ version: 1, policies: Object.fromEntries(this.projectPolicies) }, null, 2),
			{ encoding: "utf8", mode: 0o600 },
		);
		renameSync(temporary, this.path);
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

	revoke(projectId?: string | null, toolName?: string): void {
		this.store.revoke(projectId, toolName);
	}

	private emit(event: ConsentBrokerEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
