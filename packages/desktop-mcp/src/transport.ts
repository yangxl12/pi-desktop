import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpSecretResolver, McpServerProfile, McpToolResult } from "./types.ts";

export interface McpTransportClient {
	request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
	onClose?(listener: () => void): void;
	onError?(listener: (error: Error) => void): void;
	serverVersion?: { name?: string; version?: string };
	protocolVersion?: string;
	capabilities?: Record<string, unknown>;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const forward = (): void => controller.abort(signal?.reason);
	if (signal?.aborted) forward();
	else signal?.addEventListener("abort", forward, { once: true });
	const timer = setTimeout(() => controller.abort(new Error("MCP request timed out")), timeoutMs);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", forward);
		},
	};
}

class SdkClient implements McpTransportClient {
	private readonly client: Client;
	private readonly transport: StdioClientTransport | StreamableHTTPClientTransport;

	serverVersion?: { name?: string; version?: string };
	protocolVersion?: string;
	capabilities?: Record<string, unknown>;

	constructor(
		client: Client,
		transport: StdioClientTransport | StreamableHTTPClientTransport,
		options: { onToolsChanged?: () => void; onClose?: () => void; onError?: (error: Error) => void } = {},
	) {
		this.client = client;
		this.transport = transport;
		transport.onclose = () => options.onClose?.();
		transport.onerror = (error) => options.onError?.(error);
		client.onclose = () => options.onClose?.();
		client.onerror = (error) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
		this.serverVersion = client.getServerVersion() ?? undefined;
		this.capabilities = client.getServerCapabilities() as Record<string, unknown> | undefined;
	}

	/** Refresh lifecycle metadata after Client.connect() completes initialization. */
	refreshMetadata(): void {
		this.serverVersion = this.client.getServerVersion() ?? undefined;
		this.capabilities = this.client.getServerCapabilities() as Record<string, unknown> | undefined;
		if ("protocolVersion" in this.transport)
			this.protocolVersion = this.transport.protocolVersion ?? this.protocolVersion;
	}

	onClose(listener: () => void): void {
		this.transport.onclose = listener;
	}
	onError(listener: (error: Error) => void): void {
		this.transport.onerror = listener;
	}

	async request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (method === "initialize") return this.client.getServerVersion() ?? {};
		if (method === "tools/list") return this.client.listTools(params as { cursor?: string } | undefined, { signal });
		if (method === "tools/call") {
			if (!params || typeof params.name !== "string") throw new Error("MCP tool name is required");
			return this.client.callTool(
				{ name: params.name, arguments: (params.arguments as Record<string, unknown> | undefined) ?? {} },
				undefined,
				{ signal },
			);
		}
		throw new Error(`Unsupported MCP method: ${method}`);
	}

	async close(): Promise<void> {
		await this.client.close();
		await this.transport.close();
	}
}

export async function createMcpTransport(
	profile: McpServerProfile,
	secrets: McpSecretResolver | undefined,
	options: { onToolsChanged?: () => void; onClose?: () => void; onError?: (error: Error) => void } = {},
): Promise<McpTransportClient> {
	const secret = profile.credentialRef && secrets ? await secrets.get(profile.credentialRef) : null;
	const client = new Client(
		{ name: "pi-desktop", version: "0.83.0" },
		{
			capabilities: {},
			listChanged: { tools: { onChanged: () => options.onToolsChanged?.() } },
		},
	);
	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if (profile.transport === "stdio") {
		if (!profile.command) throw new Error("MCP STDIO server requires a command");
		const envSecrets =
			profile.secretEnvRefs && secrets
				? Object.fromEntries(
						await Promise.all(
							Object.entries(profile.secretEnvRefs).map(
								async ([key, ref]) => [key, await secrets.get(ref)] as const,
							),
						),
					)
				: {};
		transport = new StdioClientTransport({
			command: profile.command,
			args: profile.args,
			env: {
				...profile.env,
				...(secret ? { PI_MCP_SECRET: secret } : {}),
				...Object.fromEntries(
					Object.entries(envSecrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				),
			},
			stderr: "pipe",
			maxBufferSize: profile.maxOutputBytes,
		});
	} else {
		if (!profile.url) throw new Error("MCP HTTP server requires a URL");
		const headerSecrets =
			profile.secretHeaderRefs && secrets
				? Object.fromEntries(
						await Promise.all(
							Object.entries(profile.secretHeaderRefs).map(
								async ([key, ref]) => [key, await secrets.get(ref)] as const,
							),
						),
					)
				: {};
		transport = new StreamableHTTPClientTransport(new URL(profile.url), {
			requestInit: {
				headers: {
					...(secret ? { authorization: `Bearer ${secret}` } : {}),
					...Object.fromEntries(
						Object.entries(headerSecrets).filter(
							(entry): entry is [string, string] => typeof entry[1] === "string",
						),
					),
				},
			},
		});
	}
	const wrapped = new SdkClient(client, transport, options);
	await client.connect(transport);
	wrapped.refreshMetadata();
	return wrapped;
}

export async function callMcpTool(
	client: McpTransportClient,
	name: string,
	argumentsValue: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<McpToolResult> {
	const result = await client.request("tools/call", { name, arguments: argumentsValue }, signal);
	if (typeof result !== "object" || result === null) throw new Error("MCP tool response is invalid");
	const value = result as Record<string, unknown>;
	if (!Array.isArray(value.content)) throw new Error("MCP tool response has no content");
	return {
		content: value.content.filter(
			(item): item is Record<string, unknown> => typeof item === "object" && item !== null,
		),
		isError: value.isError === true,
	};
}

export function createTimedSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	return withTimeout(signal, timeoutMs);
}
