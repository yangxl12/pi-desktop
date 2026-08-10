import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpManager } from "@earendil-works/pi-desktop-mcp";
import { RpcPiAgentPort } from "@earendil-works/pi-desktop-pi-bridge";
import { afterEach, describe, expect, it } from "vitest";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url));
	const fakeModel = join(fixtureDirectory, "fake-openai-model.mjs");
const fakeMcp = join(fixtureDirectory, "fake-mcp-server.mjs");
const toolBridgeExtension = fileURLToPath(
	new URL("../../../packages/desktop-pi-bridge/src/tool-bridge-extension.ts", import.meta.url),
);

interface RunningFixture {
	child: ChildProcessWithoutNullStreams;
	port: number;
}

const fixtures: RunningFixture[] = [];

async function startFixture(logPath: string): Promise<RunningFixture> {
	const child = spawn(process.execPath, [fakeModel], {
		cwd: fixtureDirectory,
		env: { ...process.env, FAKE_OPENAI_LOG_PATH: logPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const port = await new Promise<number>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Fake OpenAI model did not start")), 10_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
			const lineEnd = output.indexOf("\n");
			if (lineEnd < 0) return;
			const line = output.slice(0, lineEnd).trim();
			try {
				const ready = JSON.parse(line) as { type?: unknown; port?: unknown };
				if (ready.type === "ready" && typeof ready.port === "number") {
					clearTimeout(timer);
					resolve(ready.port);
				}
			} catch {
				// The fixture only emits JSON readiness data; leave malformed output in the timeout error path.
			}
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`Fake OpenAI model exited before readiness (code=${code})`));
		});
	});
	const fixture = { child, port };
	fixtures.push(fixture);
	return fixture;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Pi/MCP integration state");
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
}

afterEach(async () => {
	await Promise.all(
		fixtures.splice(0).map(
			(fixture) =>
				new Promise<void>((resolve) => {
					if (fixture.child.exitCode !== null) return resolve();
					fixture.child.once("exit", () => resolve());
					fixture.child.kill("SIGTERM");
				}),
		),
	);
});

describe("Pi to MCP tool integration", () => {
	it(
		"routes a real Pi model tool call through McpManager and returns the result to the model",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-desktop-pi-mcp-"));
			const modelLog = join(directory, "model-requests.json");
			const mcpLog = join(directory, "mcp-calls.jsonl");
			const fixture = await startFixture(modelLog);
			const mcp = new McpManager();
			const runtime = new RpcPiAgentPort({
				enableToolBridge: true,
				requestTimeoutMs: 30_000,
				toolBridgeExtensionPath: toolBridgeExtension,
			});
			const toolEvents: string[] = [];
			const mcpEvents: string[] = [];
			mcp.subscribe((event) => {
				if (event.type === "tool.started" || event.type === "tool.finished") mcpEvents.push(event.type);
			});
			runtime.subscribe((event) => {
				if (event.type === "tool_started" || event.type === "tool_finished") toolEvents.push(event.type);
			});
			try {
				await mcp.start({
					id: "echo-server",
					name: "Echo fixture",
					transport: "stdio",
					command: process.execPath,
					args: [fakeMcp],
					env: { FAKE_MCP_LOG_PATH: mcpLog },
					url: null,
					credentialRef: null,
					namespace: "demo",
					enabled: true,
					timeoutMs: 10_000,
					maxOutputBytes: 1_048_576,
					projectId: null,
				});
				const tools = mcp.listToolDefinitions(undefined, true);
				expect(tools).toEqual([expect.objectContaining({ name: "demo_echo" })]);
				await runtime.start({
					cwd: directory,
					sessionDirectory: join(directory, "sessions"),
					agentDirectory: join(directory, "agent"),
					projectTrusted: true,
					skillDirectories: [],
					extensionPaths: [],
					env: {},
					sensitiveValues: [],
					models: [
						{
							providerId: "fixture",
							displayName: "Fixture",
							baseUrl: `http://127.0.0.1:${fixture.port}/v1`,
							modelId: "fixture-model",
							apiKey: "fixture-key",
							capabilities: { streaming: true, toolCalling: true, thinking: false, multimodal: false },
						},
					],
					selectedModel: { providerId: "fixture", modelId: "fixture-model" },
					thinkingLevel: "off",
					runtimeId: "pi-mcp-integration",
					tools,
				});
				await runtime.prompt("Call the echo MCP tool");
				await waitFor(() => toolEvents.includes("tool_finished"));
				await waitFor(async () => {
					try {
						return (await runtime.getMessages()).some((message) =>
							message.parts.some((part) => part.type === "text" && part.text.includes("MCP echo completed")),
						);
					} catch {
						return false;
					}
				});
				const requests = JSON.parse(await readFile(modelLog, "utf8")) as Array<Record<string, unknown>>;
				let mcpCalls: unknown[] = [];
				try {
					mcpCalls = (await readFile(mcpLog, "utf8"))
						.trim()
						.split(/\r?\n/)
						.filter(Boolean)
						.map((line) => JSON.parse(line));
				} catch (error) {
					throw new Error(
						`MCP fixture log missing: ${error instanceof Error ? error.message : String(error)}; ` +
						`MCP events=${JSON.stringify(mcpEvents)}; model requests=${JSON.stringify(requests)}`,
					);
				}
				expect(requests).toHaveLength(2);
				expect(requests[0]?.tools).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ function: expect.objectContaining({ name: "demo_echo" }) }),
				]),
			);
				expect(requests[1]?.messages).toEqual(
					expect.arrayContaining([expect.objectContaining({ role: "tool", content: expect.stringContaining("from-fake-model") })]),
				);
				expect(mcpCalls).toEqual([{ value: "from-fake-model" }]);
				expect(mcpEvents).toEqual(expect.arrayContaining(["tool.started", "tool.finished"]));
				expect(toolEvents).toEqual(expect.arrayContaining(["tool_started", "tool_finished"]));
			} finally {
				await runtime.stop();
				await mcp.stopAll();
				await rm(directory, { recursive: true, force: true });
			}
		},
		45_000,
	);
});
