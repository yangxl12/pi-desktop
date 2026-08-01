import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopApplication, MemorySecretStore } from "@earendil-works/pi-desktop-core";
import { McpManager } from "@earendil-works/pi-desktop-mcp";
import { RecoveringPiAgentPort, RpcPiAgentPort } from "@earendil-works/pi-desktop-pi-bridge";
import type { DesktopCommand } from "@earendil-works/pi-desktop-protocol";
import { parseDesktopRequest } from "@earendil-works/pi-desktop-protocol";
import {
	backupBeforeMigration,
	desktopDataDirectory,
	PiSessionFileRepository,
	projectSessionDirectory,
	SqliteMetadataRepository,
} from "@earendil-works/pi-desktop-storage";
import { exportDiagnostics } from "./diagnostics.ts";
import { createElectronDesktopPorts } from "./electron-ports.ts";
import { FileSingleInstancePort } from "./file-single-instance.ts";
import { ConsoleDesktopLogger } from "./logger.ts";
import { FetchModelConnectionTester, NativeFolderPickerPort, PlatformSecretStore } from "./platform-services.ts";
import { MemoryShortcutPort, MemoryTrayPort, MemoryWindowPort } from "./ports.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rendererDirectory = process.env.PI_DESKTOP_RENDERER_DIR ?? join(here, "..", "renderer");
const lucideDirectory =
	process.env.PI_DESKTOP_LUCIDE_DIR ?? join(here, "..", "..", "..", "..", "node_modules", "lucide", "dist", "esm");
const port = Number(process.env.PI_DESKTOP_PORT ?? 4317);

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
	response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

async function serveRenderer(pathname: string, response: ServerResponse): Promise<void> {
	if (pathname.startsWith("/vendor/lucide/")) {
		const requested = pathname.slice("/vendor/lucide/".length);
		const filePath = normalize(join(lucideDirectory, requested));
		if (relative(lucideDirectory, filePath).startsWith("..")) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}
		try {
			const content = await readFile(filePath);
			response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
			response.end(content);
		} catch {
			sendJson(response, 404, { error: "Not found" });
		}
		return;
	}
	const requested = pathname === "/" ? "index.html" : pathname.slice("/".length);
	const filePath = normalize(join(rendererDirectory, requested));
	if (relative(rendererDirectory, filePath).startsWith("..")) {
		sendJson(response, 403, { error: "Forbidden" });
		return;
	}
	try {
		const content = await readFile(filePath);
		const contentType = filePath.endsWith(".css")
			? "text/css; charset=utf-8"
			: filePath.endsWith(".js")
				? "text/javascript; charset=utf-8"
				: "text/html; charset=utf-8";
		response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
		response.end(content);
	} catch {
		sendJson(response, 404, { error: "Not found" });
	}
}

async function main(): Promise<void> {
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
	const dataDirectory = desktopDataDirectory(platform);
	const electronPorts = createElectronDesktopPorts();
	const window = electronPorts?.window ?? new MemoryWindowPort();
	const tray = electronPorts?.tray ?? new MemoryTrayPort();
	const shortcut = electronPorts?.shortcut ?? new MemoryShortcutPort();
	await electronPorts?.refresh();
	const singleInstance = new FileSingleInstancePort(dataDirectory);
	if (!(await singleInstance.acquire(() => window.show()))) {
		console.error("Pi desktop is already running");
		return;
	}
	const databasePath = join(dataDirectory, "metadata.sqlite");
	await backupBeforeMigration(databasePath);
	const metadata = new SqliteMetadataRepository(databasePath);
	const secrets =
		platform === "win32" || platform === "darwin"
			? new PlatformSecretStore(dataDirectory, process.platform)
			: new MemorySecretStore();
	const mcp = new McpManager({
		secrets,
		consent: async () => false,
	});
	const app = new DesktopApplication({
		platform,
		ports: {
			window,
			tray,
			shortcut,
			singleInstance,
			folderPicker: new NativeFolderPickerPort(process.platform),
			diagnosticsExport: (diagnostics) =>
				exportDiagnostics(join(dataDirectory, "diagnostics"), diagnostics, { platform, node: process.version }),
		},
		pi: new RecoveringPiAgentPort(
			new RpcPiAgentPort(
				process.env.PI_DESKTOP_RPC_ENTRY ? { args: [process.env.PI_DESKTOP_RPC_ENTRY] } : undefined,
			),
		),
		metadata,
		secrets,
		sessionFiles: new PiSessionFileRepository(),
		modelConnection: new FetchModelConnectionTester(),
		mcp,
		agentDirectory: join(dataDirectory, "agent"),
		sessionDirectory: (project) => projectSessionDirectory(dataDirectory, project.id),
		logger: new ConsoleDesktopLogger(),
	});
	await app.initialize();
	const server = createServer(async (request, response) => {
		try {
			const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
			if (request.method === "GET" && pathname === "/api/state") {
				sendJson(response, 200, app.getState());
				return;
			}
			if (request.method === "POST" && pathname === "/api/command") {
				const requestValue = parseDesktopRequest(await readJson(request));
				sendJson(response, 200, await app.dispatch(requestValue.command as DesktopCommand, requestValue.requestId));
				return;
			}
			if (request.method === "GET") {
				await serveRenderer(pathname, response);
				return;
			}
			sendJson(response, 405, { error: "Method not allowed" });
		} catch (error: unknown) {
			sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	server.listen(port, "127.0.0.1", () => console.log(`Pi desktop host listening at http://127.0.0.1:${port}`));
	let shuttingDown = false;
	const shutdown = async (): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		await app.dispatch({ type: "app.quit" });
		await new Promise<void>((resolve) => server.close(() => resolve()));
		electronPorts?.dispose();
	};
	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
