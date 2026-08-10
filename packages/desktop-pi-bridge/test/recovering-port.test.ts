import type {
	AgentEvent,
	PiAgentPort,
	PiAgentState,
	RuntimeCommand,
	RuntimeStartOptions,
} from "@earendil-works/pi-desktop-core";
import type { DesktopMessage } from "@earendil-works/pi-desktop-protocol";
import { describe, expect, it } from "vitest";
import { RecoveringPiAgentPort } from "../src/recovering-port.ts";

function runtimeOptions(): RuntimeStartOptions {
	return {
		cwd: "C:\\project",
		sessionDirectory: "C:\\sessions",
		agentDirectory: "C:\\agent",
		skillDirectories: [],
		extensionPaths: [],
		env: {},
		sensitiveValues: [],
		models: [],
		thinkingLevel: "high",
		runtimeId: "runtime-1",
	};
}

function runtimeState(): PiAgentState {
	return {
		isStreaming: false,
		thinkingLevel: "high",
		modelProvider: null,
		modelId: null,
		sessionId: null,
		sessionPath: null,
		messageCount: 0,
	};
}

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

/**
 * First start emits a crash event and throws. Every retry blocks on the gate
 * (so the test can stop the runtime mid-recovery) and then throws again.
 */
class FlakyPort implements PiAgentPort {
	private readonly listeners = new Set<(event: AgentEvent) => void>();
	private readonly gate: Deferred;
	startCalls = 0;

	constructor(gate: Deferred) {
		this.gate = gate;
	}

	subscribe(listener: (event: AgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(options: RuntimeStartOptions): Promise<PiAgentState> {
		this.startCalls += 1;
		if (this.startCalls === 1) {
			for (const listener of this.listeners)
				listener({ type: "error", runtimeId: options.runtimeId, error: "runtime crashed" });
			throw new Error("first start failed");
		}
		await this.gate.promise;
		throw new Error("retry start failed");
	}

	async stop(): Promise<void> {}
	async prompt(): Promise<void> {}
	async steer(): Promise<void> {}
	async followUp(): Promise<void> {}
	async abort(): Promise<void> {}
	async getState(): Promise<PiAgentState> {
		return runtimeState();
	}
	async getMessages(): Promise<DesktopMessage[]> {
		return [];
	}
	async getCommands(): Promise<RuntimeCommand[]> {
		return [];
	}
	async newSession(): Promise<PiAgentState> {
		return runtimeState();
	}
	async switchSession(): Promise<PiAgentState> {
		return runtimeState();
	}
	async setSessionName(): Promise<void> {}
	async setThinkingLevel(): Promise<void> {}
	async setModel(): Promise<void> {}
}

describe("RecoveringPiAgentPort", () => {
	it("does not crash when the runtime is stopped during a recovery retry", async () => {
		const gate = deferred();
		const inner = new FlakyPort(gate);
		const port = new RecoveringPiAgentPort(inner, { baseDelayMs: 5, maxAttempts: 3 });

		const startPromise = port.start(runtimeOptions());
		await expect(startPromise).rejects.toThrow("first start failed");

		// The crash event triggered recover(); wait until its retry is blocked in inner.start().
		await new Promise<void>((resolve) => {
			const check = (): void => {
				if (inner.startCalls >= 2) resolve();
				else setTimeout(check, 5);
			};
			check();
		});

		await port.stop();
		gate.resolve();

		// Give the recover loop time to run. The old implementation crashed here with
		// "Cannot read properties of undefined (reading 'runtimeId')" and rejected the
		// recover() promise, taking the host down.
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		expect(port).toBeDefined();
	});

	it("exhausts retries without throwing when the runtime never recovers", async () => {
		const gate = deferred();
		gate.resolve();
		const inner = new FlakyPort(gate);
		const port = new RecoveringPiAgentPort(inner, { baseDelayMs: 2, maxAttempts: 2 });
		const diagnostics: string[] = [];
		port.subscribe((event: AgentEvent) => {
			if (event.type === "diagnostic") diagnostics.push(event.message);
		});

		const startPromise = port.start(runtimeOptions());
		await expect(startPromise).rejects.toThrow("first start failed");

		await new Promise<void>((resolve) => setTimeout(resolve, 150));
		expect(diagnostics.filter((message) => message.includes("Restarting Pi runtime"))).toHaveLength(2);
		expect(inner.startCalls).toBe(3);
	});
});
