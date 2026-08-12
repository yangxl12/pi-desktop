import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	type DesktopCommand,
	DesktopError,
	type DesktopErrorCode,
	type DesktopResponse,
	parseDesktopRequest,
} from "@earendil-works/pi-desktop-protocol";
import { projectsFromState, serveProjectFile } from "./file-preview.ts";

export interface HostHttpLimits {
	maxBodyBytes: number;
	maxHeaderBytes: number;
	maxSseClients: number;
	maxSseHistory: number;
	maxSseBufferBytes: number;
	requestTimeoutMs: number;
	folderPickTimeoutMs: number;
	heartbeatMs: number;
	maxConcurrentCommands: number;
}

export const DEFAULT_HOST_HTTP_LIMITS: HostHttpLimits = {
	maxBodyBytes: 1_048_576,
	maxHeaderBytes: 16_384,
	maxSseClients: 32,
	maxSseHistory: 512,
	maxSseBufferBytes: 1_048_576,
	requestTimeoutMs: 30_000,
	folderPickTimeoutMs: 5 * 60_000,
	heartbeatMs: 15_000,
	maxConcurrentCommands: 8,
};

export interface DesktopHostHttpApplication {
	getState(): unknown;
	dispatch(command: DesktopCommand, requestId?: string): Promise<DesktopResponse>;
	subscribe(listener: (event: unknown) => void): () => void;
}

export interface DesktopHostHttpServerOptions {
	app: DesktopHostHttpApplication;
	hostToken: string;
	port: number;
	allowedOrigins?: readonly string[];
	limits?: Partial<HostHttpLimits>;
	staticHandler?: (pathname: string, response: ServerResponse, request: IncomingMessage) => Promise<void>;
}

export interface DesktopHostHttpServer {
	server: Server;
	events: SseEventHub;
	close(): Promise<void>;
}

export class HostHttpError extends Error {
	readonly code: DesktopErrorCode;
	readonly statusCode: number;
	readonly details: Record<string, unknown> | undefined;

	constructor(statusCode: number, code: DesktopErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "HostHttpError";
		this.code = code;
		this.statusCode = statusCode;
		this.details = details;
	}
}

export function statusForDesktopError(code: DesktopErrorCode | undefined): number {
	switch (code) {
		case "UNAUTHORIZED":
			return 401;
		case "PERMISSION_DENIED":
			return 403;
		case "NOT_FOUND":
			return 404;
		case "CONFLICT":
			return 409;
		case "TIMEOUT":
			return 408;
		case "NOT_READY":
			return 503;
		case "NOT_SUPPORTED":
			return 501;
		case "PROCESS_ERROR":
		case "PROTOCOL_ERROR":
			return 502;
		case "INVALID_ARGUMENT":
			return 400;
		default:
			return 500;
	}
}

function headerBytes(request: IncomingMessage): number {
	return request.rawHeaders.reduce((total, value) => total + Buffer.byteLength(value), 0);
}

function parseCookieHeader(value: string | undefined): Record<string, string> {
	if (!value) return {};
	return Object.fromEntries(
		value.split(";").flatMap((part) => {
			const index = part.indexOf("=");
			if (index < 0) return [];
			try {
				return [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
			} catch {
				return [];
			}
		}),
	);
}

function requestToken(request: IncomingMessage): string | undefined {
	const header = request.headers["x-pi-desktop-token"] ?? request.headers.authorization;
	if (typeof header === "string") return header.startsWith("Bearer ") ? header.slice(7) : header;
	return parseCookieHeader(request.headers.cookie).pi_desktop_token;
}

function requestId(request: IncomingMessage): string {
	const value = request.headers["x-request-id"];
	return typeof value === "string" && value.trim() ? value : randomUUID();
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown, requestIdValue?: string): void {
	if (response.headersSent) return;
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"x-request-id": requestIdValue ?? randomUUID(),
	});
	response.end(JSON.stringify(value));
}

function errorPayload(error: unknown, fallbackRequestId: string): { statusCode: number; body: unknown } {
	if (error instanceof HostHttpError) {
		return {
			statusCode: error.statusCode,
			body: {
				success: false,
				requestId: fallbackRequestId,
				error: { code: error.code, message: error.message, details: error.details },
			},
		};
	}
	const desktopError =
		error instanceof DesktopError
			? error
			: new DesktopError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
	return {
		statusCode: statusForDesktopError(desktopError.code),
		body: { success: false, requestId: fallbackRequestId, error: desktopError.toJSON() },
	};
}

export async function readJsonBody(
	request: IncomingMessage,
	maxBodyBytes = DEFAULT_HOST_HTTP_LIMITS.maxBodyBytes,
	timeoutMs = DEFAULT_HOST_HTTP_LIMITS.requestTimeoutMs,
): Promise<unknown> {
	const contentLength = Number(request.headers["content-length"] ?? 0);
	if (Number.isFinite(contentLength) && contentLength > maxBodyBytes)
		throw new HostHttpError(413, "INVALID_ARGUMENT", "Request body is too large", { maxBodyBytes });
	const chunks: Buffer[] = [];
	let size = 0;
	let timer: NodeJS.Timeout | undefined;
	try {
		const value = await new Promise<Buffer>((resolve, reject) => {
			timer = setTimeout(() => reject(new HostHttpError(408, "TIMEOUT", "Request body timed out")), timeoutMs);
			request.on("data", (chunk: Buffer | string) => {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += buffer.byteLength;
				if (size > maxBodyBytes) {
					request.resume();
					reject(new HostHttpError(413, "INVALID_ARGUMENT", "Request body is too large", { maxBodyBytes }));
					return;
				}
				chunks.push(buffer);
			});
			request.once("end", () => resolve(Buffer.concat(chunks)));
			request.once("error", reject);
		});
		const text = value.toString("utf8").trim();
		if (!text) throw new DesktopError("INVALID_ARGUMENT", "Request body is required");
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new DesktopError("INVALID_ARGUMENT", "Request body must be valid JSON");
		}
	} finally {
		if (timer) clearTimeout(timer);
	}
}

interface SseClient {
	response: ServerResponse;
	bufferedBytes: number;
}

interface SseHistoryEntry {
	id: number;
	event: string;
	data: string;
}

export class SseEventHub {
	private readonly clients = new Set<SseClient>();
	private readonly history: SseHistoryEntry[] = [];
	private readonly maxClients: number;
	private readonly maxHistory: number;
	private readonly maxBufferBytes: number;
	private readonly heartbeatTimer: NodeJS.Timeout;
	private sequence = 0;

	constructor(limits: Pick<HostHttpLimits, "maxSseClients" | "maxSseHistory" | "maxSseBufferBytes" | "heartbeatMs">) {
		this.maxClients = limits.maxSseClients;
		this.maxHistory = limits.maxSseHistory;
		this.maxBufferBytes = limits.maxSseBufferBytes;
		this.heartbeatTimer = setInterval(() => this.heartbeat(), limits.heartbeatMs);
		this.heartbeatTimer.unref();
	}

	get currentEventId(): number {
		return this.sequence;
	}

	connect(response: ServerResponse, lastEventId: string | undefined, state: unknown): void {
		if (this.clients.size >= this.maxClients)
			throw new HostHttpError(429, "CONFLICT", "Too many event stream clients", { maxSseClients: this.maxClients });
		response.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		response.write("retry: 1000\n\n");
		const parsedLastId = Number(lastEventId);
		if (Number.isSafeInteger(parsedLastId) && parsedLastId >= 0) {
			const firstId = this.history[0]?.id ?? this.sequence + 1;
			if (parsedLastId < firstId - 1) {
				this.write(response, {
					id: this.sequence,
					event: "desktop",
					data: JSON.stringify({ type: "desktop.reset", reason: "replay_unavailable", state }),
				});
			} else {
				for (const entry of this.history) if (entry.id > parsedLastId) this.write(response, entry);
			}
		} else {
			response.write(": connected\n\n");
		}
		const client: SseClient = { response, bufferedBytes: 0 };
		this.clients.add(client);
		const cleanup = () => this.clients.delete(client);
		response.once("close", cleanup);
		response.once("error", cleanup);
	}

	publish(value: unknown, event = "desktop"): number {
		const entry: SseHistoryEntry = { id: ++this.sequence, event, data: JSON.stringify(value) };
		this.history.push(entry);
		while (this.history.length > this.maxHistory) this.history.shift();
		for (const client of this.clients) {
			if (!this.write(client.response, entry, client)) this.clients.delete(client);
		}
		return entry.id;
	}

	close(reason = "host_closed"): void {
		clearInterval(this.heartbeatTimer);
		for (const client of this.clients) {
			this.write(
				client.response,
				{ id: ++this.sequence, event: "desktop", data: JSON.stringify({ type: "desktop.closed", reason }) },
				client,
			);
			client.response.end();
		}
		this.clients.clear();
	}

	private heartbeat(): void {
		for (const client of this.clients) {
			try {
				if (!client.response.write(": heartbeat\n\n")) {
					if (client.response.writableLength > this.maxBufferBytes) {
						client.response.destroy();
						this.clients.delete(client);
					}
				}
			} catch {
				this.clients.delete(client);
			}
		}
	}

	private write(response: ServerResponse, entry: SseHistoryEntry, client?: SseClient): boolean {
		const frame = `id: ${entry.id}\nevent: ${entry.event}\ndata: ${entry.data}\n\n`;
		try {
			const accepted = response.write(frame);
			if (client) {
				client.bufferedBytes += Buffer.byteLength(frame);
				if (client.bufferedBytes > this.maxBufferBytes || response.writableLength > this.maxBufferBytes) {
					response.destroy();
					return false;
				}
				if (accepted) client.bufferedBytes = 0;
			}
			return true;
		} catch {
			return false;
		}
	}
}

function allowedOrigin(request: IncomingMessage, origins: ReadonlySet<string>): boolean {
	const origin = request.headers.origin;
	if (typeof origin === "string" && origin && !origins.has(origin)) return false;
	const referer = request.headers.referer;
	if (typeof referer === "string" && referer) {
		try {
			if (!origins.has(new URL(referer).origin)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new HostHttpError(408, "TIMEOUT", "Desktop command timed out")), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export function createDesktopHostHttpServer(options: DesktopHostHttpServerOptions): DesktopHostHttpServer {
	const limits = { ...DEFAULT_HOST_HTTP_LIMITS, ...options.limits };
	const origins = new Set(
		options.allowedOrigins ?? [`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`],
	);
	const events = new SseEventHub(limits);
	let activeCommands = 0;
	const unsubscribe = options.app.subscribe((event) => events.publish(event));
	const server = createServer({ maxHeaderSize: limits.maxHeaderBytes }, async (request, response) => {
		const currentRequestId = requestId(request);
		try {
			if (headerBytes(request) > limits.maxHeaderBytes)
				throw new HostHttpError(431, "INVALID_ARGUMENT", "Request headers are too large");
			const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
			if (!pathname.startsWith("/api/")) {
				if (request.method === "GET" && options.staticHandler) {
					const bootstrapToken = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("hostToken");
					if (bootstrapToken && bootstrapToken !== options.hostToken)
						throw new HostHttpError(401, "UNAUTHORIZED", "Host token is invalid");
					if (pathname === "/")
						response.setHeader(
							"set-cookie",
							`pi_desktop_token=${encodeURIComponent(options.hostToken)}; HttpOnly; SameSite=Strict; Path=/`,
						);
					await options.staticHandler(pathname, response, request);
					return;
				}
				writeJson(
					response,
					404,
					{ success: false, requestId: currentRequestId, error: { code: "NOT_FOUND", message: "Not found" } },
					currentRequestId,
				);
				return;
			}
			if (requestToken(request) !== options.hostToken)
				throw new HostHttpError(401, "UNAUTHORIZED", "Host token is required");
			if (!allowedOrigin(request, origins))
				throw new HostHttpError(403, "PERMISSION_DENIED", "Origin is not allowed");
			if (request.method === "GET" && pathname === "/api/state") {
				writeJson(response, 200, options.app.getState(), currentRequestId);
				return;
			}
			if (request.method === "GET" && pathname === "/api/events") {
				events.connect(response, request.headers["last-event-id"] as string | undefined, options.app.getState());
				return;
			}
			if ((request.method === "GET" || request.method === "HEAD") && pathname === "/api/file") {
				const url = new URL(request.url ?? "/", "http://127.0.0.1");
				await serveProjectFile(
					projectsFromState(options.app.getState()),
					url.searchParams.get("projectId") ?? "",
					url.searchParams.get("path") ?? "",
					response,
					request.method === "HEAD",
				);
				return;
			}
			if (request.method === "POST" && pathname === "/api/command") {
				if (request.headers["content-type"]?.split(";", 1)[0].trim() !== "application/json")
					throw new HostHttpError(415, "INVALID_ARGUMENT", "Content-Type must be application/json");
				if (activeCommands >= limits.maxConcurrentCommands)
					throw new HostHttpError(429, "CONFLICT", "Too many concurrent commands");
				activeCommands += 1;
				try {
					const requestValue = parseDesktopRequest(
						await readJsonBody(request, limits.maxBodyBytes, limits.requestTimeoutMs),
					);
					const timeoutMs =
						requestValue.command.type === "projects.addFromFolder"
							? limits.folderPickTimeoutMs
							: limits.requestTimeoutMs;
					const result = await withTimeout(
						options.app.dispatch(requestValue.command as DesktopCommand, requestValue.requestId),
						timeoutMs,
					);
					const status = result.success ? 200 : statusForDesktopError(result.error?.code);
					writeJson(response, status, result, requestValue.requestId);
				} finally {
					activeCommands -= 1;
				}
				return;
			}
			throw new HostHttpError(404, "NOT_FOUND", "API route not found");
		} catch (error: unknown) {
			const failure = errorPayload(error, currentRequestId);
			writeJson(response, failure.statusCode, failure.body, currentRequestId);
		}
	});
	server.requestTimeout = limits.requestTimeoutMs;
	server.headersTimeout = Math.max(limits.requestTimeoutMs, 5_000);
	return {
		server,
		events,
		async close() {
			unsubscribe();
			events.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
