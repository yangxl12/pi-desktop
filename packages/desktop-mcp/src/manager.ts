import { randomUUID } from "node:crypto";
import type { RuntimeToolDefinition } from "@earendil-works/pi-desktop-core";
import type { McpPackageInstaller } from "./package-installer.ts";
import type { ConsentBroker } from "./policy.ts";
import { callMcpTool, createMcpTransport, createTimedSignal, type McpTransportClient } from "./transport.ts";
import type {
	McpConsent,
	McpEvent,
	McpEventListener,
	McpSecretResolver,
	McpServerProfile,
	McpServerSnapshot,
	McpTool,
	McpToolResult,
} from "./types.ts";

interface Connection {
	client: McpTransportClient;
	snapshot: McpServerSnapshot;
	tools: McpTool[];
	reconnectAttempt: number;
	reconnectTimer?: ReturnType<typeof setTimeout>;
}

export interface McpManagerOptions {
	secrets?: McpSecretResolver;
	consent?: McpConsent;
	respondConsent?: (requestId: string, approved: boolean, scope?: "once" | "session" | "project") => boolean;
	consentBroker?: ConsentBroker;
	packageInstaller?: McpPackageInstaller;
	maxInputBytes?: number;
	maxConcurrentCalls?: number;
	maxCallsPerMinute?: number;
}

function toolList(result: unknown, profile: McpServerProfile): McpTool[] {
	if (typeof result !== "object" || result === null || !Array.isArray((result as Record<string, unknown>).tools)) {
		throw new Error("MCP tools/list response is invalid");
	}
	return (result as { tools: unknown[] }).tools.map((tool) => {
		if (typeof tool !== "object" || tool === null || typeof (tool as Record<string, unknown>).name !== "string") {
			throw new Error("MCP tool has invalid metadata");
		}
		const value = tool as Record<string, unknown>;
		return {
			name: value.name as string,
			description: typeof value.description === "string" ? value.description : undefined,
			inputSchema:
				typeof value.inputSchema === "object" && value.inputSchema !== null
					? (value.inputSchema as Record<string, unknown>)
					: {},
			serverId: profile.id,
			namespacedName: `${profile.namespace}.${value.name}`,
		};
	});
}

function outputBytes(result: McpToolResult): number {
	return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(value: unknown, path: string, seen = new Set<object>()): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`MCP tool input at ${path} must be a finite JSON number`);
		return;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new Error(`MCP tool input at ${path} must not contain a cycle`);
		seen.add(value);
		for (const [index, item] of value.entries()) assertJsonValue(item, `${path}[${index}]`, seen);
		seen.delete(value);
		return;
	}
	if (isJsonObject(value)) {
		if (seen.has(value)) throw new Error(`MCP tool input at ${path} must not contain a cycle`);
		seen.add(value);
		for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, seen);
		seen.delete(value);
		return;
	}
	throw new Error(`MCP tool input at ${path} must contain JSON-compatible values`);
}

function inputBytes(argumentsValue: Record<string, unknown>): number {
	if (!isJsonObject(argumentsValue)) throw new Error("MCP tool input must be a JSON object");
	assertJsonValue(argumentsValue, "$");
	const encoded = JSON.stringify(argumentsValue);
	if (!encoded) throw new Error("MCP tool input could not be encoded as JSON");
	return Buffer.byteLength(encoded, "utf8");
}

function valueMatchesType(value: unknown, type: string): boolean {
	if (type === "object") return isJsonObject(value);
	if (type === "array") return Array.isArray(value);
	if (type === "string") return typeof value === "string";
	if (type === "number") return typeof value === "number" && Number.isFinite(value);
	if (type === "integer") return typeof value === "number" && Number.isInteger(value);
	if (type === "boolean") return typeof value === "boolean";
	if (type === "null") return value === null;
	return true;
}

function validateInputSchema(schema: Record<string, unknown>, value: unknown, path = "$", depth = 0): void {
	if (depth > 16) throw new Error("MCP tool input schema is nested too deeply");
	const type = schema.type;
	if (typeof type === "string" && !valueMatchesType(value, type))
		throw new Error(`MCP tool input at ${path} does not match schema type ${type}`);
	if (
		Array.isArray(schema.enum) &&
		!schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
	)
		throw new Error(`MCP tool input at ${path} is not an allowed schema value`);

	const properties = isJsonObject(schema.properties) ? schema.properties : undefined;
	const required = Array.isArray(schema.required)
		? schema.required.filter((key): key is string => typeof key === "string")
		: [];
	if (properties || required.length > 0 || schema.additionalProperties === false) {
		if (!isJsonObject(value)) throw new Error(`MCP tool input at ${path} must be an object`);
		for (const key of required)
			if (!Object.hasOwn(value, key)) throw new Error(`MCP tool input is missing required property ${key}`);
		if (schema.additionalProperties === false)
			for (const key of Object.keys(value))
				if (!properties || !Object.hasOwn(properties, key))
					throw new Error(`MCP tool input property ${key} is not allowed`);
		if (properties)
			for (const [key, childSchema] of Object.entries(properties))
				if (Object.hasOwn(value, key) && isJsonObject(childSchema))
					validateInputSchema(childSchema, value[key], `${path}.${key}`, depth + 1);
	}
	if (Array.isArray(value) && isJsonObject(schema.items))
		for (const [index, item] of value.entries())
			validateInputSchema(schema.items, item, `${path}[${index}]`, depth + 1);
}

function publicProfile(profile: McpServerProfile): McpServerProfile {
	return {
		...profile,
		args: [...profile.args],
		env: Object.fromEntries(Object.keys(profile.env).map((key) => [key, "[redacted]"])),
	};
}

export class McpManager {
	private readonly connections = new Map<string, Connection>();
	private readonly profiles = new Map<string, McpServerProfile>();
	private readonly listeners = new Set<McpEventListener>();
	private readonly options: McpManagerOptions;
	private readonly consentUnsubscribe: (() => void) | undefined;
	private readonly maxInputBytes: number;
	private readonly maxConcurrentCalls: number;
	private readonly maxCallsPerMinute: number;
	private activeToolCalls = 0;
	private readonly toolCallTimes = new Map<string, number[]>();

	constructor(options: McpManagerOptions = {}) {
		this.options = options;
		this.maxInputBytes = options.maxInputBytes ?? 65_536;
		this.maxConcurrentCalls = options.maxConcurrentCalls ?? 4;
		this.maxCallsPerMinute = options.maxCallsPerMinute ?? 60;
		if (!Number.isInteger(this.maxInputBytes) || this.maxInputBytes < 1_024 || this.maxInputBytes > 1_048_576)
			throw new Error("MCP input limit must be between 1024 and 1048576 bytes");
		if (!Number.isInteger(this.maxConcurrentCalls) || this.maxConcurrentCalls < 1 || this.maxConcurrentCalls > 32)
			throw new Error("MCP concurrent call limit must be between 1 and 32");
		if (!Number.isInteger(this.maxCallsPerMinute) || this.maxCallsPerMinute < 1 || this.maxCallsPerMinute > 10_000)
			throw new Error("MCP tool rate limit must be between 1 and 10000 calls per minute");
		this.consentUnsubscribe = options.consentBroker?.subscribe((event) => {
			if (event.type === "consent.required")
				this.emit({
					type: "consent.required",
					serverId: event.request.serverId,
					createdAt: new Date().toISOString(),
					request: event.request,
				});
			else
				this.emit({
					type: "consent.resolved",
					serverId: "",
					createdAt: new Date().toISOString(),
					requestId: event.requestId,
					approved: event.approved,
				});
		});
	}

	subscribe(listener: McpEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(): McpServerSnapshot[] {
		return [...this.profiles.values()].map(
			(profile) =>
				this.connections.get(profile.id)?.snapshot ?? {
					profile: publicProfile(profile),
					status: "stopped",
					toolCount: 0,
					lastError: null,
					startedAt: null,
				},
		);
	}

	setProfiles(profiles: readonly McpServerProfile[]): void {
		this.profiles.clear();
		for (const profile of profiles)
			this.profiles.set(profile.id, { ...profile, args: [...profile.args], env: { ...profile.env } });
	}

	async start(profile: McpServerProfile): Promise<McpServerSnapshot> {
		this.validateProfile(profile);
		let launchProfile = profile;
		if (
			(profile.launchKind ??
				(profile.transport === "stdio" && profile.command === "npx"
					? "managed-npm"
					: profile.transport === "http"
						? "http"
						: "executable")) === "managed-npm"
		) {
			if (!this.options.packageInstaller) throw new Error("Managed MCP package installer is unavailable");
			const installed = await this.options.packageInstaller.install(profile);
			launchProfile = {
				...profile,
				command: installed.command,
				args: installed.args,
				packageVersion: installed.packageVersion,
				launchKind: "managed-npm",
			};
		}
		await this.stop(profile.id, "profile restarted");
		this.profiles.set(profile.id, {
			...profile,
			packageVersion: launchProfile.packageVersion ?? profile.packageVersion,
			args: [...profile.args],
			env: { ...profile.env },
		});
		if (!profile.enabled)
			return this.list().find((snapshot) => snapshot.profile.id === profile.id) as McpServerSnapshot;
		const starting: McpServerSnapshot = {
			profile: publicProfile(launchProfile),
			status: "starting",
			toolCount: 0,
			lastError: null,
			startedAt: null,
		};
		try {
			const timeout = createTimedSignal(undefined, profile.timeoutMs);
			try {
				const timeoutError = new Promise<never>((_, reject) =>
					timeout.signal.addEventListener(
						"abort",
						() =>
							reject(
								timeout.signal.reason instanceof Error
									? timeout.signal.reason
									: new Error("MCP connection timed out"),
							),
						{ once: true },
					),
				);
				const transportPromise = createMcpTransport(launchProfile, this.options.secrets, {
					onToolsChanged: () => void this.refreshTools(launchProfile.id),
					onClose: () => this.handleConnectionClosed(launchProfile.id),
					onError: (error) => this.handleConnectionError(launchProfile.id, error),
				});
				const client = await Promise.race([transportPromise, timeoutError]).catch((error: unknown) => {
					void transportPromise.then((lateClient) => lateClient.close()).catch(() => undefined);
					throw error;
				});
				const tools = await this.listAllTools(client, launchProfile, timeout.signal);
				this.assertNamespaceAvailable(launchProfile, tools);
				const snapshot: McpServerSnapshot = {
					profile: publicProfile(launchProfile),
					status: "ready",
					toolCount: tools.length,
					lastError: null,
					startedAt: new Date().toISOString(),
					connectedAt: new Date().toISOString(),
					lastConnectedAt: new Date().toISOString(),
					serverInfo: client.serverVersion ?? null,
					protocolVersion: client.protocolVersion ?? "2025-06-18",
					capabilities: client.capabilities,
					agentAvailability: "unknown",
					reconnectAttempt: 0,
				};
				this.connections.set(profile.id, { client, snapshot, tools, reconnectAttempt: 0 });
				this.emit({ type: "server.started", serverId: profile.id, createdAt: new Date().toISOString(), snapshot });
				this.emit({
					type: "tools.changed",
					serverId: profile.id,
					createdAt: new Date().toISOString(),
					tools: this.listTools(),
				});
				return snapshot;
			} finally {
				timeout.dispose();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const snapshot: McpServerSnapshot = { ...starting, status: "error", lastError: message };
			this.connections.set(profile.id, {
				client: {
					request: async () => {
						throw new Error(message);
					},
					close: async () => {},
				},
				snapshot,
				tools: [],
				reconnectAttempt: 0,
			});
			this.emit({ type: "server.error", serverId: profile.id, createdAt: new Date().toISOString(), error: message });
			return snapshot;
		}
	}

	async stop(serverId: string, reason?: string): Promise<void> {
		const connection = this.connections.get(serverId);
		if (!connection) return;
		this.connections.delete(serverId);
		if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
		await connection.client.close();
		this.emit({ type: "server.stopped", serverId, createdAt: new Date().toISOString(), reason });
		this.emit({ type: "tools.changed", serverId, createdAt: new Date().toISOString(), tools: this.listTools() });
	}

	async stopAll(reason?: string): Promise<void> {
		await Promise.all([...this.connections.keys()].map((serverId) => this.stop(serverId, reason)));
	}

	dispose(): void {
		this.consentUnsubscribe?.();
		this.listeners.clear();
	}

	listTools(projectId?: string): McpTool[] {
		return [...this.connections.values()]
			.flatMap((connection) => connection.tools)
			.filter((tool) => {
				const projectScope = this.profiles.get(tool.serverId)?.projectId;
				return projectScope === null || projectScope === undefined || projectScope === projectId;
			})
			.map((tool) => ({ ...tool, inputSchema: { ...tool.inputSchema } }));
	}

	listToolDefinitions(projectId?: string, trusted = false): RuntimeToolDefinition[] {
		return this.listTools(projectId).map((tool) => ({
			name: tool.namespacedName.replace(/[^a-zA-Z0-9_-]/g, "_"),
			description: tool.description ?? `MCP tool ${tool.namespacedName}`,
			parameters: { ...tool.inputSchema },
			call: (argumentsValue, signal) =>
				this.callTool(tool.namespacedName, argumentsValue, { projectId: projectId ?? null, trusted, signal }),
		}));
	}

	respondConsent(requestId: string, approved: boolean, scope: "once" | "session" | "project" = "once"): boolean {
		return this.options.respondConsent?.(requestId, approved, scope) ?? false;
	}

	revokeConsent(projectId?: string | null, toolName?: string): void {
		this.options.consentBroker?.revoke(projectId, toolName);
	}

	removeManagedPackage(serverId: string): Promise<void> {
		return this.options.packageInstaller?.remove(serverId) ?? Promise.resolve();
	}

	async test(profile: McpServerProfile): Promise<McpServerSnapshot> {
		const temporaryId = `${profile.id}__test_${randomUUID().slice(0, 8)}`;
		const snapshot = await this.start({
			...profile,
			id: temporaryId,
			namespace: `${profile.namespace}_test_${temporaryId.slice(-4)}`,
			enabled: true,
		});
		await this.stop(temporaryId, "connection test complete");
		this.profiles.delete(temporaryId);
		return {
			...snapshot,
			profile: publicProfile({
				...profile,
				packageVersion: snapshot.profile.packageVersion ?? profile.packageVersion,
			}),
		};
	}

	async callTool(
		namespacedName: string,
		argumentsValue: Record<string, unknown>,
		context: { projectId: string | null; trusted: boolean; signal?: AbortSignal },
	): Promise<McpToolResult> {
		const tool = this.listTools(context.projectId ?? undefined).find(
			(candidate) => candidate.namespacedName === namespacedName,
		);
		if (!tool) throw new Error(`MCP tool not found: ${namespacedName}`);
		const profile = this.profiles.get(tool.serverId);
		const connection = this.connections.get(tool.serverId);
		if (!profile || !connection || connection.snapshot.status !== "ready")
			throw new Error(`MCP server is not ready: ${tool.serverId}`);
		const argumentBytes = inputBytes(argumentsValue);
		if (argumentBytes > this.maxInputBytes)
			throw new Error(`MCP tool input exceeds ${this.maxInputBytes} byte limit`);
		validateInputSchema(tool.inputSchema, argumentsValue);
		const requestId = randomUUID();
		if (
			!context.trusted &&
			!(
				(await this.options.consent?.({
					requestId,
					argumentsSummary: Object.keys(argumentsValue).sort().join(","),
					serverId: tool.serverId,
					toolName: tool.name,
					projectId: context.projectId,
				})) ?? false
			)
		) {
			throw new Error("MCP tool invocation requires trusted project or explicit consent");
		}
		const release = this.acquireToolCall(tool.namespacedName);
		let timeout: ReturnType<typeof createTimedSignal> | undefined;
		try {
			this.emit({
				type: "tool.started",
				serverId: tool.serverId,
				createdAt: new Date().toISOString(),
				toolName: tool.name,
				requestId,
			});
			timeout = createTimedSignal(context.signal, profile.timeoutMs);
			const result = await callMcpTool(connection.client, tool.name, argumentsValue, timeout.signal);
			if (outputBytes(result) > profile.maxOutputBytes)
				throw new Error(`MCP tool output exceeds ${profile.maxOutputBytes} byte limit`);
			this.emit({
				type: "tool.finished",
				serverId: tool.serverId,
				createdAt: new Date().toISOString(),
				toolName: tool.name,
				requestId,
				failed: result.isError === true,
			});
			return result;
		} catch (error) {
			this.emit({
				type: "tool.finished",
				serverId: tool.serverId,
				createdAt: new Date().toISOString(),
				toolName: tool.name,
				requestId,
				failed: true,
			});
			throw error;
		} finally {
			timeout?.dispose();
			release();
		}
	}

	private acquireToolCall(namespacedName: string): () => void {
		if (this.activeToolCalls >= this.maxConcurrentCalls)
			throw new Error(`MCP concurrent tool call limit of ${this.maxConcurrentCalls} has been reached`);
		const now = Date.now();
		const recent = (this.toolCallTimes.get(namespacedName) ?? []).filter((timestamp) => timestamp > now - 60_000);
		if (recent.length >= this.maxCallsPerMinute)
			throw new Error(`MCP tool rate limit of ${this.maxCallsPerMinute} calls per minute has been reached`);
		recent.push(now);
		this.toolCallTimes.set(namespacedName, recent);
		this.activeToolCalls += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.activeToolCalls -= 1;
		};
	}

	private validateProfile(profile: McpServerProfile): void {
		if (!profile.id || !profile.name || !profile.namespace)
			throw new Error("MCP server id, name, and namespace are required");
		if (!/^[a-z][a-z0-9_-]*$/i.test(profile.namespace)) throw new Error("MCP namespace is invalid");
		if (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 100 || profile.timeoutMs > 300_000)
			throw new Error("MCP timeout must be between 100 and 300000 ms");
		if (
			!Number.isInteger(profile.maxOutputBytes) ||
			profile.maxOutputBytes < 1024 ||
			profile.maxOutputBytes > 10_485_760
		)
			throw new Error("MCP output limit must be between 1024 and 10485760 bytes");
		if (profile.transport === "stdio" && !profile.command) throw new Error("MCP STDIO server requires a command");
		if (profile.transport === "http") {
			if (!profile.url) throw new Error("MCP HTTP server requires a URL");
			const url = new URL(profile.url);
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new Error("MCP HTTP URL must use HTTP or HTTPS");
		}
	}

	private async listAllTools(
		client: McpTransportClient,
		profile: McpServerProfile,
		signal: AbortSignal,
	): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 100; page += 1) {
			const raw = await client.request("tools/list", cursor ? { cursor } : undefined, signal);
			const result = toolList(raw, profile);
			tools.push(...result);
			cursor =
				raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).nextCursor === "string"
					? (raw as { nextCursor: string }).nextCursor
					: undefined;
			if (!cursor) break;
		}
		return tools;
	}

	private async refreshTools(serverId: string): Promise<void> {
		const connection = this.connections.get(serverId);
		const profile = this.profiles.get(serverId);
		if (!connection || !profile) return;
		const timeout = createTimedSignal(undefined, profile.timeoutMs);
		try {
			connection.tools = await this.listAllTools(connection.client, profile, timeout.signal);
			connection.snapshot = { ...connection.snapshot, toolCount: connection.tools.length, lastError: null };
			this.emit({ type: "tools.changed", serverId, createdAt: new Date().toISOString(), tools: this.listTools() });
			this.emit({
				type: "server.started",
				serverId,
				createdAt: new Date().toISOString(),
				snapshot: connection.snapshot,
			});
		} catch (error) {
			this.handleConnectionError(serverId, error instanceof Error ? error : new Error(String(error)));
		} finally {
			timeout.dispose();
		}
	}

	private handleConnectionError(serverId: string, error: Error): void {
		const connection = this.connections.get(serverId);
		if (!connection) return;
		connection.snapshot = { ...connection.snapshot, status: "error", lastError: error.message };
		this.emit({ type: "server.error", serverId, createdAt: new Date().toISOString(), error: error.message });
		this.scheduleReconnect(serverId);
	}

	private handleConnectionClosed(serverId: string): void {
		this.handleConnectionError(serverId, new Error("MCP transport closed"));
	}

	private scheduleReconnect(serverId: string): void {
		const connection = this.connections.get(serverId);
		const profile = this.profiles.get(serverId);
		if (!connection || !profile || !profile.enabled || connection.reconnectTimer) return;
		if (connection.reconnectAttempt >= 5) return;
		connection.reconnectAttempt += 1;
		connection.snapshot = { ...connection.snapshot, reconnectAttempt: connection.reconnectAttempt };
		const reconnectAttempt = connection.reconnectAttempt;
		const delay = Math.min(30_000, 500 * 2 ** (connection.reconnectAttempt - 1));
		connection.reconnectTimer = setTimeout(() => {
			connection.reconnectTimer = undefined;
			void this.start(profile).then((snapshot) => {
				if (snapshot.status !== "error") return;
				const failed = this.connections.get(serverId);
				if (failed) failed.reconnectAttempt = reconnectAttempt;
				this.scheduleReconnect(serverId);
			});
		}, delay);
	}

	private assertNamespaceAvailable(profile: McpServerProfile, tools: McpTool[]): void {
		const names = new Set(
			this.listTools()
				.filter((tool) => tool.serverId !== profile.id)
				.map((tool) => tool.namespacedName),
		);
		for (const tool of tools)
			if (names.has(tool.namespacedName)) throw new Error(`MCP tool namespace collision: ${tool.namespacedName}`);
	}

	private emit(event: McpEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
