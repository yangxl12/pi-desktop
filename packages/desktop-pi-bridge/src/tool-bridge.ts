import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { RuntimeToolDefinition } from "@earendil-works/pi-desktop-core";

interface PendingCall {
	controller: AbortController;
}

interface PendingApply {
	resolve(generation: number): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** JSONL side-channel between the Pi child extension and the Host tool gateway. */
export class PiToolBridge {
	private readonly token = randomUUID();
	private readonly server: Server;
	private socket: Socket | undefined;
	private helloReceived = false;
	private buffer = "";
	private helloResolve: (() => void) | undefined;
	private helloReject: ((error: Error) => void) | undefined;
	private readonly pendingApplies = new Map<number, PendingApply>();
	private readonly pending = new Map<string, PendingCall>();
	private tools = new Map<string, RuntimeToolDefinition>();
	private generation = 0;

	private readonly options: { timeoutMs?: number };

	constructor(options: { timeoutMs?: number } = {}) {
		this.options = options;
		this.server = createServer((socket) => this.accept(socket));
	}

	async listen(): Promise<{ port: number; token: string }> {
		this.helloReceived = false;
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Pi tool bridge failed to bind");
		return { port: address.port, token: this.token };
	}

	async waitForHello(timeoutMs = 10_000): Promise<void> {
		if (this.helloReceived) return;
		await new Promise<void>((resolve, reject) => {
			this.helloResolve = resolve;
			this.helloReject = reject;
			const timer = setTimeout(() => {
				this.helloResolve = undefined;
				this.helloReject = undefined;
				reject(new Error("Pi tool bridge handshake timed out"));
			}, timeoutMs);
			const original = this.helloResolve;
			this.helloResolve = () => {
				clearTimeout(timer);
				original?.();
			};
		});
	}

	async replace(tools: readonly RuntimeToolDefinition[]): Promise<number> {
		if (!this.socket || !this.helloReceived) throw new Error("Pi tool bridge is not connected");
		this.generation += 1;
		this.tools = new Map(tools.map((tool) => [tool.name, tool]));
		const generation = this.generation;
		const payload = {
			type: "tools.replace",
			generation,
			tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
		};
		const ack = new Promise<number>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingApplies.delete(generation);
				reject(new Error(`Pi tool bridge generation ${generation} apply timed out`));
			}, this.options.timeoutMs ?? 10_000);
			this.pendingApplies.set(generation, { resolve, reject, timer });
		});
		this.write(payload);
		return ack;
	}

	async close(): Promise<void> {
		for (const pending of this.pending.values()) pending.controller.abort(new Error("Pi tool bridge closed"));
		this.pending.clear();
		this.rejectApplies(new Error("Pi tool bridge closed"));
		this.socket?.destroy();
		this.socket = undefined;
		this.helloReceived = false;
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private accept(socket: Socket): void {
		if (this.socket) {
			socket.destroy();
			return;
		}
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.read(chunk));
		socket.on("error", (error) => this.fail(error));
		socket.on("close", () => {
			if (this.socket === socket) {
				this.socket = undefined;
				this.helloReceived = false;
				this.rejectApplies(new Error("Pi tool bridge connection closed"));
			}
		});
	}

	private read(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			index = this.buffer.indexOf("\n");
			if (!line.trim()) continue;
			try {
				this.handle(JSON.parse(line) as Record<string, unknown>);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private handle(message: Record<string, unknown>): void {
		if (message.type === "hello") {
			if (message.token !== this.token) {
				this.fail(new Error("Pi tool bridge token mismatch"));
				this.socket?.destroy();
				return;
			}
			this.helloReceived = true;
			this.helloResolve?.();
			this.helloResolve = undefined;
			this.helloReject = undefined;
			return;
		}
		if (!this.helloReceived) return;
		if (message.type === "tools.applied") {
			const generation = Number(message.generation);
			const pending = this.pendingApplies.get(generation);
			if (!pending) return;
			this.pendingApplies.delete(generation);
			clearTimeout(pending.timer);
			pending.resolve(generation);
			return;
		}
		if (message.type === "tool.cancel" && typeof message.requestId === "string") {
			this.pending.get(message.requestId)?.controller.abort(new Error("Tool call cancelled"));
			return;
		}
		if (message.type !== "tool.call" || typeof message.requestId !== "string" || typeof message.name !== "string")
			return;
		const tool = this.tools.get(message.name);
		if (!tool) {
			this.write({
				type: "tool.result",
				requestId: message.requestId,
				ok: false,
				error: "Tool is no longer active",
			});
			return;
		}
		const controller = new AbortController();
		this.pending.set(message.requestId, { controller });
		void tool
			.call((message.arguments as Record<string, unknown>) ?? {}, controller.signal)
			.then(
				(result) => this.write({ type: "tool.result", requestId: message.requestId, ok: true, result }),
				(error) =>
					this.write({
						type: "tool.result",
						requestId: message.requestId,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
			)
			.finally(() => this.pending.delete(message.requestId as string));
	}

	private write(value: Record<string, unknown>): void {
		if (this.socket && !this.socket.destroyed) this.socket.write(`${JSON.stringify(value)}\n`);
	}

	private fail(error: Error): void {
		this.helloReject?.(error);
		this.helloResolve = undefined;
		this.helloReject = undefined;
		this.rejectApplies(error);
	}

	private rejectApplies(error: Error): void {
		for (const [generation, pending] of this.pendingApplies) {
			this.pendingApplies.delete(generation);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}
}

export function createPiToolBridgeClient(port: number, token: string): Socket {
	const socket = createConnection({ host: "127.0.0.1", port });
	socket.once("connect", () => socket.write(`${JSON.stringify({ type: "hello", token })}\n`));
	return socket;
}
