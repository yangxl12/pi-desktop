import { randomUUID } from "node:crypto";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: string;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id?: string;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export function request(method: string, params?: Record<string, unknown>): JsonRpcRequest {
	return { jsonrpc: "2.0", id: randomUUID(), method, ...(params ? { params } : {}) };
}

export function parseResponse(value: unknown): JsonRpcResponse {
	if (typeof value !== "object" || value === null) throw new Error("MCP response is not an object");
	const response = value as Record<string, unknown>;
	if (response.jsonrpc !== "2.0" || (typeof response.id !== "string" && response.id !== undefined)) {
		throw new Error("MCP response has invalid JSON-RPC framing");
	}
	if (response.error !== undefined && (typeof response.error !== "object" || response.error === null)) {
		throw new Error("MCP response has invalid error");
	}
	return response as unknown as JsonRpcResponse;
}

export function assertResult(response: JsonRpcResponse): unknown {
	if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
	return response.result;
}
