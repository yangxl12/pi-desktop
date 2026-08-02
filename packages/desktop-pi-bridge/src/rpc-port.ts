import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	PiAgentEvent,
	PiAgentPort,
	PiAgentState,
	PiCommandInfo,
	PiRuntimeOptions,
	RuntimeToolDefinition,
} from "@earendil-works/pi-desktop-core";
import type { DesktopMessage, ThinkingLevel } from "@earendil-works/pi-desktop-protocol";
import { DesktopError } from "@earendil-works/pi-desktop-protocol";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import { normalizeCommands, normalizeMessage, normalizePiEvent, normalizeState } from "./normalize.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

function resolveDefaultRpcEntry(): string {
	return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
}

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcPiAgentPortOptions {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	requestTimeoutMs?: number;
}

function responseData(response: RpcResponse): unknown {
	if (!response.success) throw new DesktopError("PROCESS_ERROR", response.error ?? "Pi RPC command failed");
	return "data" in response ? response.data : undefined;
}

function safeEnvironmentName(providerId: string): string {
	return providerId.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
}

function buildModelsJson(options: PiRuntimeOptions): {
	content: string;
	env: Record<string, string>;
	secrets: string[];
} {
	const providers: Record<
		string,
		{
			baseUrl: string;
			api: "openai-completions";
			apiKey: string;
			models: Array<{ id: string; name: string; baseUrl?: string; reasoning: boolean }>;
		}
	> = {};
	const env: Record<string, string> = {};
	const secrets: string[] = [];
	for (const model of options.models) {
		const environmentName = `PI_DESKTOP_API_KEY_${safeEnvironmentName(model.providerId)}`;
		const provider = providers[model.providerId] ?? {
			baseUrl: model.baseUrl,
			api: "openai-completions" as const,
			apiKey: `$${environmentName}`,
			models: [],
		};
		providers[model.providerId] = provider;
		provider.models.push({
			id: model.modelId,
			name: model.displayName,
			baseUrl: model.baseUrl === provider.baseUrl ? undefined : model.baseUrl,
			reasoning: true,
		});
		if (model.apiKey) secrets.push(model.apiKey);
		env[environmentName] = model.apiKey ?? "pi-desktop-local";
	}
	return { content: JSON.stringify({ providers }, null, 2), env, secrets };
}

export class RpcPiAgentPort implements PiAgentPort {
	private readonly options: RpcPiAgentPortOptions;
	private process: ChildProcess | undefined;
	private stopReader: (() => void) | undefined;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(event: PiAgentEvent) => void>();
	private state: PiAgentState = {
		isStreaming: false,
		thinkingLevel: "off",
		modelProvider: null,
		modelId: null,
		sessionPath: null,
		sessionRef: null,
		sessionId: null,
		messageCount: 0,
	};
	private stderr = "";
	private stderrBuffer = "";
	private sensitiveValues: string[] = [];
	private runtimeOptions: PiRuntimeOptions | undefined;
	private streamingMessageId: string | undefined;
	private tools: RuntimeToolDefinition[] = [];

	constructor(options: RpcPiAgentPortOptions = {}) {
		this.options = options;
	}

	async start(options: PiRuntimeOptions): Promise<PiAgentState> {
		await this.stop();
		this.runtimeOptions = options;
		this.tools = [...(options.tools ?? [])];
		const modelConfig = buildModelsJson(options);
		this.sensitiveValues = modelConfig.secrets;
		await mkdir(options.agentDirectory, { recursive: true, mode: 0o700 });
		await mkdir(options.sessionDirectory, { recursive: true, mode: 0o700 });
		await writeFile(join(options.agentDirectory, "models.json"), modelConfig.content, {
			encoding: "utf8",
			mode: 0o600,
		});
		const command = this.options.command ?? process.execPath;
		const args = [...(this.options.args ?? [resolveDefaultRpcEntry()])];
		args.push("--session-dir", options.sessionDirectory);
		const sessionPath = options.sessionPath ?? options.sessionRef ?? undefined;
		if (sessionPath && existsSync(sessionPath)) args.push("--session", sessionPath);
		args.push(options.projectTrusted ? "--approve" : "--no-approve");
		if (options.globalSystemPrompt?.trim()) args.push("--append-system-prompt", options.globalSystemPrompt);
		for (const directory of options.skillDirectories) args.push("--skill", directory);
		for (const extensionPath of options.extensionPaths) args.push("--extension", extensionPath);
		if (options.selectedModel)
			args.push("--provider", options.selectedModel.providerId, "--model", options.selectedModel.modelId);
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: {
				...process.env,
				...this.options.env,
				PI_CODING_AGENT_DIR: options.agentDirectory,
				...modelConfig.env,
				...options.env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = child;
		this.sensitiveValues = [...modelConfig.secrets, ...options.sensitiveValues];
		if (!child.stdin || !child.stdout)
			throw new DesktopError("PROCESS_ERROR", "Pi RPC process did not expose stdin/stdout");
		child.stdout.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => this.handleStderr(chunk));
		this.stopReader = attachJsonlLineReader(
			child.stdout,
			(line) => this.handleLine(line),
			(error) => this.fail(error),
		);
		child.once("error", (error) => this.fail(error));
		child.once("exit", (code, signal) => {
			if (this.process === child)
				this.fail(new Error(`Pi RPC exited (code=${code} signal=${signal}). ${this.stderr}`));
		});
		const stateResponse = await this.send({ type: "get_state" });
		this.state = normalizeState(responseData(stateResponse));
		const messagesResponse = await this.send({ type: "get_messages" });
		const messages = (responseData(messagesResponse) as { messages?: unknown[] } | undefined)?.messages;
		if (Array.isArray(messages)) this.state.messageCount = messages.length;
		await this.send({ type: "get_commands" });
		await this.send({ type: "set_thinking_level", level: options.thinkingLevel });
		this.state.thinkingLevel = options.thinkingLevel;
		this.emit({ type: "ready", runtimeId: options.runtimeId, state: { ...this.state } });
		return { ...this.state };
	}

	async stop(): Promise<void> {
		const child = this.process;
		if (!child) return;
		this.process = undefined;
		this.streamingMessageId = undefined;
		this.stopReader?.();
		this.stopReader = undefined;
		this.rejectPending(new Error("Pi RPC process stopped"));
		if (child.exitCode !== null) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 1000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}

	async prompt(message: string): Promise<void> {
		await this.send({ type: "prompt", message });
	}
	async steer(message: string): Promise<void> {
		await this.send({ type: "steer", message });
	}
	async followUp(message: string): Promise<void> {
		await this.send({ type: "follow_up", message });
	}
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async newSession(): Promise<PiAgentState> {
		await this.send({ type: "new_session" });
		return this.getState();
	}

	async switchSession(sessionPath: string): Promise<PiAgentState> {
		await this.send({ type: "switch_session", sessionPath });
		return this.getState();
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	async getState(): Promise<PiAgentState> {
		const response = await this.send({ type: "get_state" });
		this.state = normalizeState(responseData(response));
		return { ...this.state };
	}

	async getMessages(): Promise<DesktopMessage[]> {
		const response = await this.send({ type: "get_messages" });
		const messages = (responseData(response) as { messages?: unknown[] } | undefined)?.messages ?? [];
		return messages.map((message) => normalizeMessage(message));
	}

	async getCommands(): Promise<PiCommandInfo[]> {
		const response = await this.send({ type: "get_commands" });
		return normalizeCommands(responseData(response));
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
		this.state.thinkingLevel = level;
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		await this.send({ type: "set_model", provider, modelId });
		this.state.modelProvider = provider;
		this.state.modelId = modelId;
	}

	setTools(tools: readonly RuntimeToolDefinition[]): void {
		this.tools = tools.map((tool) => ({ ...tool }));
	}

	subscribe(listener: (event: PiAgentEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private handleStderr(chunk: string): void {
		this.stderrBuffer = `${this.stderrBuffer}${chunk}`;
		const lines = this.stderrBuffer.split(/\r?\n/);
		this.stderrBuffer = lines.pop() ?? "";
		for (const line of lines) {
			const sanitized = this.sanitize(line);
			this.stderr = `${this.stderr}${sanitized}\n`.slice(-8000);
			if (sanitized.trim() && this.runtimeOptions) {
				this.emit({
					type: "diagnostic",
					runtimeId: this.runtimeOptions.runtimeId,
					level: "warning",
					message: sanitized,
				});
			}
		}
	}

	private handleLine(line: string): void {
		if (!line) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.fail(new Error("Pi RPC emitted invalid JSON"));
			return;
		}
		if (typeof parsed !== "object" || parsed === null) return;
		const value = parsed as { type?: unknown; id?: unknown };
		if (value.type === "response" && typeof value.id === "string") {
			const pending = this.pending.get(value.id);
			if (!pending) return;
			this.pending.delete(value.id);
			clearTimeout(pending.timer);
			pending.resolve(parsed as RpcResponse);
			return;
		}
		const normalized = normalizePiEvent(parsed);
		if (!normalized || !this.runtimeOptions) return;
		const event =
			normalized.type === "state_changed"
				? { ...normalized, state: { ...this.state, ...normalized.state } }
				: normalized;
		if (event.type === "state_changed" || event.type === "ready") this.state = { ...this.state, ...event.state };
		if (event.type === "message_started") {
			if (event.message.role === "assistant") this.streamingMessageId = event.message.id;
			this.state = { ...this.state, isStreaming: true, messageCount: this.state.messageCount + 1 };
		}
		if (event.type === "message_delta" && this.streamingMessageId) event.messageId = this.streamingMessageId;
		if (event.type === "message_finished") {
			if (event.message.role === "assistant" && this.streamingMessageId) event.message.id = this.streamingMessageId;
		}
		if (event.type === "aborted") {
			this.state = { ...this.state, isStreaming: false };
			this.streamingMessageId = undefined;
		}
		if (event.type === "state_changed" && event.state.isStreaming === false) this.streamingMessageId = undefined;
		this.emit({ ...event, runtimeId: this.runtimeOptions.runtimeId } as PiAgentEvent);
	}

	private send(command: RpcCommandBody): Promise<RpcResponse> {
		const child = this.process;
		if (!child?.stdin || child.stdin.destroyed || !child.stdin.writable)
			return Promise.reject(new DesktopError("NOT_READY", "Pi RPC process is not running"));
		const id = `desktop_${randomUUID()}`;
		const fullCommand = { ...command, id } as RpcCommand;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new DesktopError("TIMEOUT", `Timed out waiting for Pi RPC ${command.type}`));
			}, this.options.requestTimeoutMs ?? 30_000);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin?.write(serializeJsonLine(fullCommand), (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				pending.reject(error);
			});
		});
	}

	private rejectPending(error: Error): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}

	private fail(error: Error): void {
		this.rejectPending(error);
		if (this.runtimeOptions)
			this.emit({ type: "error", runtimeId: this.runtimeOptions.runtimeId, error: this.sanitize(error.message) });
	}

	private sanitize(message: string): string {
		let sanitized = message;
		for (const value of this.sensitiveValues) if (value) sanitized = sanitized.split(value).join("[redacted]");
		return sanitized;
	}

	private emit(event: PiAgentEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}
