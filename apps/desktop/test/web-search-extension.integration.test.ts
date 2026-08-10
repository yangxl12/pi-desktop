import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcPiAgentPort } from "@earendil-works/pi-desktop-pi-bridge";
import { afterEach, describe, expect, it } from "vitest";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/", import.meta.url));
const fakeModel = join(fixtureDirectory, "fake-openai-model.mjs");
const webSearchExtension = fileURLToPath(
	new URL("../src/extensions/web-search.ts", import.meta.url),
);

interface RunningFixture {
	child: ChildProcessWithoutNullStreams;
	port: number;
}

const fixtures: RunningFixture[] = [];

async function startFixture(
	logPath: string,
	toolName: string,
	toolArgs = '{"value":"from-fake-model"}',
): Promise<RunningFixture> {
	const child = spawn(process.execPath, [fakeModel], {
		cwd: fixtureDirectory,
		env: { ...process.env, FAKE_OPENAI_LOG_PATH: logPath, FAKE_OPENAI_TOOL_NAME: toolName, FAKE_OPENAI_TOOL_ARGS: toolArgs },
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
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Pi web search integration state");
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

describe("Pi web search extension integration", () => {
	it(
		"loads the web search extension with its DeepSeek search module and executes the built-in search",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-desktop-web-search-"));
			const modelLog = join(directory, "model-requests.json");
			const fixture = await startFixture(modelLog, "web_search", '{"query":"latest Pi release"}');
			const runtime = new RpcPiAgentPort({ requestTimeoutMs: 30_000 });
			const toolEvents: string[] = [];
			runtime.subscribe((event) => {
				if (event.type === "tool_started" || event.type === "tool_finished") toolEvents.push(event.type);
			});
			try {
				await runtime.start({
					cwd: directory,
					sessionDirectory: join(directory, "sessions"),
					agentDirectory: join(directory, "agent"),
					projectTrusted: true,
					skillDirectories: [],
					extensionPaths: [webSearchExtension],
					env: {
						PI_DESKTOP_WEB_SEARCH_PROVIDER: "deepseek",
						PI_DESKTOP_WEB_SEARCH_DEEPSEEK_BASE_URL: `http://127.0.0.1:${fixture.port}`,
						PI_DESKTOP_WEB_SEARCH_DEEPSEEK_MODEL: "fixture-model",
						PI_DESKTOP_WEB_SEARCH_DEEPSEEK_API_KEY: "fixture-key",
					},
					sensitiveValues: ["fixture-key"],
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
					runtimeId: "web-search-integration",
				});
				await runtime.prompt("Search the web for the latest Pi release");
				await waitFor(() => toolEvents.includes("tool_finished"));
				await waitFor(async () => {
					try {
						return (await runtime.getMessages()).some((message) =>
							message.parts.some(
								(part) => part.type === "tool" && part.text.includes("DeepSeek returned HTTP 404"),
							),
						);
					} catch {
						return false;
					}
				});
				const requests = JSON.parse(await readFile(modelLog, "utf8")) as Array<Record<string, unknown>>;
				expect(requests[0]?.tools).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ function: expect.objectContaining({ name: "web_search" }) }),
					]),
				);
				expect(toolEvents).toEqual(expect.arrayContaining(["tool_started", "tool_finished"]));
			} finally {
				await runtime.stop();
				await rm(directory, { recursive: true, force: true });
			}
		},
		45_000,
	);
});
