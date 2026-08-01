import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpSecretResolver, McpServerProfile, McpToolResult } from "./types.ts";

export interface McpTransportClient {
	request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
	close(): Promise<void>;
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

	constructor(client: Client, transport: StdioClientTransport | StreamableHTTPClientTransport) {
		this.client = client;
		this.transport = transport;
	}

	async request(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (method === "initialize") return this.client.getServerVersion() ?? {};
		if (method === "tools/list") return this.client.listTools(undefined, { signal });
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
): Promise<McpTransportClient> {
	const secret = profile.credentialRef && secrets ? await secrets.get(profile.credentialRef) : null;
	const client = new Client({ name: "pi-desktop", version: "0.83.0" }, { capabilities: {} });
	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if (profile.transport === "stdio") {
		if (!profile.command) throw new Error("MCP STDIO server requires a command");
		transport = new StdioClientTransport({
			command: profile.command,
			args: profile.args,
			env: { ...profile.env, ...(secret ? { PI_MCP_SECRET: secret } : {}) },
			stderr: "pipe",
			maxBufferSize: profile.maxOutputBytes,
		});
	} else {
		if (!profile.url) throw new Error("MCP HTTP server requires a URL");
		transport = new StreamableHTTPClientTransport(new URL(profile.url), {
			requestInit: { headers: secret ? { authorization: `Bearer ${secret}` } : undefined },
		});
	}
	await client.connect(transport);
	return new SdkClient(client, transport);
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
