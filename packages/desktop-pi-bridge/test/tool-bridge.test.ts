import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { createPiToolBridgeClient, PiToolBridge } from "../src/tool-bridge.ts";

function jsonlPeer(socket: Socket) {
	let buffer = "";
	const messages: Array<Record<string, unknown>> = [];
	const waiters: Array<{
		predicate(message: Record<string, unknown>): boolean;
		resolve(message: Record<string, unknown>): void;
	}> = [];
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line) continue;
			const message = JSON.parse(line) as Record<string, unknown>;
			const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
			if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0]?.resolve(message);
			else messages.push(message);
		}
	});
	return {
		next(predicate: (message: Record<string, unknown>) => boolean) {
			const index = messages.findIndex(predicate);
			if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0] as Record<string, unknown>);
			return new Promise<Record<string, unknown>>((resolve) => waiters.push({ predicate, resolve }));
		},
		send(message: Record<string, unknown>) {
			socket.write(`${JSON.stringify(message)}\n`);
		},
	};
}

describe("PiToolBridge", () => {
	it("applies generations and routes calls, errors, and cancellation", async () => {
		const bridge = new PiToolBridge({ timeoutMs: 2_000 });
		const endpoint = await bridge.listen();
		const socket = createPiToolBridgeClient(endpoint.port, endpoint.token);
		const peer = jsonlPeer(socket);
		await bridge.waitForHello();

		const replacement = bridge.replace([
			{
				name: "echo",
				description: "Echo input",
				parameters: { type: "object" },
				call: async (args) => ({ content: [{ type: "text", text: JSON.stringify(args) }] }),
			},
			{
				name: "wait",
				description: "Wait",
				parameters: { type: "object" },
				call: (_args, signal) =>
					new Promise((_resolve, reject) => {
						if (!signal) return reject(new Error("Missing cancellation signal"));
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
			},
		]);
		const replace = await peer.next((message) => message.type === "tools.replace");
		expect(replace.tools).toEqual([
			expect.objectContaining({ name: "echo" }),
			expect.objectContaining({ name: "wait" }),
		]);
		peer.send({ type: "tools.applied", generation: replace.generation });
		await expect(replacement).resolves.toBe(1);

		peer.send({ type: "tool.call", requestId: "call-1", name: "echo", arguments: { value: 1 } });
		await expect(peer.next((message) => message.requestId === "call-1")).resolves.toMatchObject({
			type: "tool.result",
			ok: true,
			result: { content: [{ type: "text", text: '{"value":1}' }] },
		});

		peer.send({ type: "tool.call", requestId: "call-2", name: "wait", arguments: {} });
		peer.send({ type: "tool.cancel", requestId: "call-2" });
		await expect(peer.next((message) => message.requestId === "call-2")).resolves.toMatchObject({
			type: "tool.result",
			ok: false,
			error: "Tool call cancelled",
		});

		peer.send({ type: "tool.call", requestId: "call-3", name: "removed", arguments: {} });
		await expect(peer.next((message) => message.requestId === "call-3")).resolves.toMatchObject({
			ok: false,
			error: "Tool is no longer active",
		});
		await bridge.close();
	});
});
