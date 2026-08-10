import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface BridgeTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

interface ToolWaiter {
	resolve(value: { content: Array<Record<string, unknown>>; isError?: boolean }): void;
	reject(error: Error): void;
	dispose(): void;
}

export default function toolBridgeExtension(pi: ExtensionAPI): void {
	const port = Number(process.env.PI_DESKTOP_TOOL_BRIDGE_PORT ?? 0);
	const token = process.env.PI_DESKTOP_TOOL_BRIDGE_TOKEN;
	if (!port || !token) return;
	const socket = createConnection({ host: "127.0.0.1", port });
	let buffer = "";
	let bridgeTools: string[] = [];
	const definitions = new Map<string, BridgeTool>();
	const waiters = new Map<string, ToolWaiter>();
	const send = (value: Record<string, unknown>) => socket.write(`${JSON.stringify(value)}\n`);
	const call = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
		const requestId = randomUUID();
		return new Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }>((resolve, reject) => {
			const onAbort = () => {
				send({ type: "tool.cancel", requestId });
				const waiter = waiters.get(requestId);
				waiter?.dispose();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("Tool call aborted"));
			};
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			waiters.set(requestId, {
				resolve,
				reject,
				dispose: () => {
					signal?.removeEventListener("abort", onAbort);
					waiters.delete(requestId);
				},
			});
			send({ type: "tool.call", requestId, name, arguments: args });
		});
	};
	const rejectWaiters = (error: Error) => {
		for (const waiter of waiters.values()) {
			waiter.dispose();
			waiter.reject(error);
		}
	};

	socket.setEncoding("utf8");
	socket.on("connect", () => send({ type: "hello", token }));
	socket.on("error", (error) => rejectWaiters(error));
	socket.on("close", () => rejectWaiters(new Error("Pi Desktop tool bridge disconnected")));
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line.trim()) continue;
			let message: Record<string, unknown>;
			try {
				message = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (message.type === "tool.result" && typeof message.requestId === "string") {
				const waiter = waiters.get(message.requestId);
				if (waiter) {
					waiter.dispose();
					if (message.ok === true)
						waiter.resolve(
							(message.result as { content: Array<Record<string, unknown>>; isError?: boolean }) ?? {
								content: [],
							},
						);
					else waiter.reject(new Error(typeof message.error === "string" ? message.error : "Tool call failed"));
				}
				continue;
			}
			if (message.type !== "tools.replace" || !Array.isArray(message.tools)) continue;
			const tools = message.tools
				.filter(
					(item): item is BridgeTool =>
						typeof item === "object" &&
						item !== null &&
						typeof (item as Record<string, unknown>).name === "string",
				)
				.map((item) => ({
					name: item.name,
					description: item.description ?? item.name,
					parameters: item.parameters ?? { type: "object" },
				}));
			for (const tool of tools) {
				definitions.set(tool.name, tool);
				pi.registerTool({
					name: tool.name,
					label: tool.name,
					description: tool.description,
					parameters: Type.Unsafe(tool.parameters),
					async execute(_toolCallId, params, signal) {
						const result = await call(tool.name, params as Record<string, unknown>, signal);
						return {
							content: result.content as any,
							...(result.isError ? { isError: true } : {}),
							details: {},
						} as any;
					},
				});
			}
			bridgeTools = tools.map((tool) => tool.name);
			const nativeTools = pi.getActiveTools().filter((name) => !definitions.has(name));
			pi.setActiveTools([...new Set([...nativeTools, ...bridgeTools])]);
			const generation = Number(message.generation);
			if (Number.isSafeInteger(generation)) send({ type: "tools.applied", generation });
		}
	});
}
