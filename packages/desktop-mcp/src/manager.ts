import { randomUUID } from "node:crypto";
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
}

export interface McpManagerOptions {
	secrets?: McpSecretResolver;
	consent?: McpConsent;
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

	constructor(options: McpManagerOptions = {}) {
		this.options = options;
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
		await this.stop(profile.id, "profile restarted");
		this.profiles.set(profile.id, { ...profile, args: [...profile.args], env: { ...profile.env } });
		if (!profile.enabled)
			return this.list().find((snapshot) => snapshot.profile.id === profile.id) as McpServerSnapshot;
		const starting: McpServerSnapshot = {
			profile: publicProfile(profile),
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
				const transportPromise = createMcpTransport(profile, this.options.secrets);
				const client = await Promise.race([transportPromise, timeoutError]).catch((error: unknown) => {
					void transportPromise.then((lateClient) => lateClient.close()).catch(() => undefined);
					throw error;
				});
				await client.request(
					"initialize",
					{
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "pi-desktop", version: "0.83.0" },
					},
					timeout.signal,
				);
				const tools = toolList(await client.request("tools/list", undefined, timeout.signal), profile);
				this.assertNamespaceAvailable(profile, tools);
				const snapshot: McpServerSnapshot = {
					profile: publicProfile(profile),
					status: "ready",
					toolCount: tools.length,
					lastError: null,
					startedAt: new Date().toISOString(),
				};
				this.connections.set(profile.id, { client, snapshot, tools });
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
			});
			this.emit({ type: "server.error", serverId: profile.id, createdAt: new Date().toISOString(), error: message });
			return snapshot;
		}
	}

	async stop(serverId: string, reason?: string): Promise<void> {
		const connection = this.connections.get(serverId);
		if (!connection) return;
		this.connections.delete(serverId);
		await connection.client.close();
		this.emit({ type: "server.stopped", serverId, createdAt: new Date().toISOString(), reason });
		this.emit({ type: "tools.changed", serverId, createdAt: new Date().toISOString(), tools: this.listTools() });
	}

	async stopAll(reason?: string): Promise<void> {
		await Promise.all([...this.connections.keys()].map((serverId) => this.stop(serverId, reason)));
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

	async test(profile: McpServerProfile): Promise<McpServerSnapshot> {
		const snapshot = await this.start({ ...profile, enabled: true });
		await this.stop(profile.id, "connection test complete");
		return snapshot;
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
		if (
			!context.trusted &&
			!(
				(await this.options.consent?.({
					serverId: tool.serverId,
					toolName: tool.name,
					projectId: context.projectId,
				})) ?? false
			)
		) {
			throw new Error("MCP tool invocation requires trusted project or explicit consent");
		}
		const requestId = randomUUID();
		this.emit({
			type: "tool.started",
			serverId: tool.serverId,
			createdAt: new Date().toISOString(),
			toolName: tool.name,
			requestId,
		});
		const timeout = createTimedSignal(context.signal, profile.timeoutMs);
		try {
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
			timeout.dispose();
		}
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
