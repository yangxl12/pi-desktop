import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopMessage } from "@earendil-works/pi-desktop-protocol";
import { describe, expect, it, vi } from "vitest";
import { DesktopApplication, FakeAgentRuntime, MemoryMetadataRepository, MemorySecretStore } from "../src/index.ts";
import type { DesktopHostPorts, SessionFileRepository, SessionFileSummary } from "../src/ports.ts";
import type { RuntimeStartOptions, RuntimeState } from "../src/runtime-contract.ts";

class TestWindow {
	private state = { visible: true, minimized: false, maximized: false, closeToTray: true };
	show(): void {
		this.state.visible = true;
	}
	hide(): void {
		this.state.visible = false;
	}
	toggle(): void {
		this.state.visible = !this.state.visible;
	}
	minimize(): void {
		this.state.minimized = true;
	}
	maximize(): void {
		this.state.maximized = !this.state.maximized;
	}
	setCloseToTray(closeToTray: boolean): void {
		this.state.closeToTray = closeToTray;
	}
	close(): void {
		this.state.visible = false;
	}
	getState(): typeof this.state {
		return { ...this.state };
	}
	onChanged(): () => void {
		return () => undefined;
	}
}

class TestTray {
	create(): void {
		/* no-op */
	}
	destroy(): void {
		/* no-op */
	}
}

class TestShortcut {
	private readonly callbacks = new Map<string, () => void>();
	register(shortcut: string, callback: () => void): void {
		if (this.callbacks.has(shortcut)) throw new Error("conflict");
		this.callbacks.set(shortcut, callback);
	}
	unregister(shortcut: string): void {
		this.callbacks.delete(shortcut);
	}
	registered(): string[] {
		return [...this.callbacks.keys()];
	}
	trigger(shortcut: string): void {
		this.callbacks.get(shortcut)?.();
	}
}

class TestSingleInstance {
	acquire(): boolean {
		return true;
	}
	release(): void {
		/* no-op */
	}
}

class DelayedSessionFiles {
	private checks = 0;

	async exists(): Promise<boolean> {
		this.checks += 1;
		return this.checks > 1;
	}

	async read(): Promise<never> {
		throw new Error("Not used by this test");
	}

	async scan(): Promise<{ sessions: []; diagnostics: [] }> {
		return { sessions: [], diagnostics: [] };
	}
}

class RecordingRuntime extends FakeAgentRuntime {
	readonly starts: RuntimeStartOptions[] = [];

	override async start(options: RuntimeStartOptions): Promise<RuntimeState> {
		this.starts.push({ ...options, skillDirectories: [...options.skillDirectories] });
		return super.start(options);
	}
}

function copyMessage(message: DesktopMessage): DesktopMessage {
	return { ...message, parts: message.parts.map((part) => ({ ...part })) };
}

/** Runtime that serves a Pi-compacted context (summary + tail) for the source session only. */
class CompactedRuntime extends FakeAgentRuntime {
	private readonly sourcePath: string;
	private readonly compacted: DesktopMessage[];
	private currentRef: string | null = null;

	constructor(sourcePath: string, compacted: DesktopMessage[]) {
		super();
		this.sourcePath = sourcePath;
		this.compacted = compacted;
	}

	override async start(options: RuntimeStartOptions): Promise<RuntimeState> {
		this.currentRef = options.sessionPath ?? options.sessionRef ?? null;
		return super.start(options);
	}

	override async newSession(): Promise<RuntimeState> {
		const state = await super.newSession();
		this.currentRef = state.sessionRef ?? null;
		return state;
	}

	override async switchSession(sessionRef: string): Promise<RuntimeState> {
		this.currentRef = sessionRef;
		return super.switchSession(sessionRef);
	}

	override async getMessages(): Promise<DesktopMessage[]> {
		return this.currentRef === this.sourcePath ? this.compacted.map(copyMessage) : [];
	}
}

/** Session files that serve the durable JSONL transcript for the source session only. */
class TranscriptSessionFiles implements SessionFileRepository {
	private readonly sessionPath: string;
	private readonly transcript: DesktopMessage[];
	private readonly summary: SessionFileSummary;

	constructor(sessionPath: string, transcript: DesktopMessage[]) {
		this.sessionPath = sessionPath;
		this.transcript = transcript;
		this.summary = {
			id: "session-transcript",
			sessionPath,
			title: "Compacted session",
			createdAt: "2026-08-11T00:00:00.000Z",
			updatedAt: "2026-08-11T01:00:00.000Z",
			modelProvider: "deepseek",
			modelId: "deepseek-v4-flash",
			thinkingLevel: "high",
			leafId: "leaf-1",
			hasMessages: true,
		};
	}

	async exists(): Promise<boolean> {
		return true;
	}

	async read(): Promise<SessionFileSummary> {
		return this.summary;
	}

	async scan(): Promise<{ sessions: SessionFileSummary[]; diagnostics: string[] }> {
		return { sessions: [this.summary], diagnostics: [] };
	}

	async readMessages(sessionPath: string): Promise<DesktopMessage[]> {
		return sessionPath === this.sessionPath ? this.transcript.map(copyMessage) : [];
	}
}

function ports(): DesktopHostPorts {
	return {
		window: new TestWindow(),
		tray: new TestTray(),
		shortcut: new TestShortcut(),
		singleInstance: new TestSingleInstance(),
	};
}

describe("desktop application", () => {
	it("treats a cancelled native folder selection as a no-op", async () => {
		const app = new DesktopApplication({
			platform: "win32",
			ports: { ...ports(), folderPicker: { selectProjectFolder: async () => null } },
			pi: new FakeAgentRuntime(),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();

		const response = await app.dispatch({ type: "projects.addFromFolder" });

		expect(response).toEqual(expect.objectContaining({ success: true, data: null }));
		expect(app.getState().projects).toEqual([]);
		expect(app.getState().diagnostics).toEqual([]);
	});

	it("creates a runtime and exposes fake Pi streaming events", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new FakeAgentRuntime({ response: "ok" }),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		const events: string[] = [];
		app.subscribe((event) => events.push(event.type));
		const project = await app.dispatch({ type: "projects.add", rootPath: root });
		expect(project.success).toBe(true);
		await app.dispatch({ type: "agent.prompt", text: "hello" });
		expect(
			app.getState().messages.some((message) => message.role === "assistant" && message.parts[0]?.text === "ok"),
		).toBe(true);
		expect(app.getState().messages.find((message) => message.role === "assistant")?.durationMs).toEqual(
			expect.any(Number),
		);
		expect(events).toContain("runtime.ready");
		expect(events).toContain("message.delta");
	});

	it("rolls back a conflicting shortcut registration", async () => {
		const shortcut = new TestShortcut();
		const app = new DesktopApplication({
			platform: "win32",
			ports: { ...ports(), shortcut },
			pi: new FakeAgentRuntime(),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		shortcut.register("Alt+X", () => undefined);
		const response = await app.dispatch({ type: "settings.update", patch: { invokeShortcut: "Alt+X" } });
		expect(response.success).toBe(false);
		expect(shortcut.registered()).toContain("Alt+Shift+O");
	});

	it("keeps the host alive when the default shortcut is already taken at startup", async () => {
		// Regression: a conflicting global shortcut (taken by another app) used
		// to crash the whole host during initialize; it must degrade to a
		// diagnostic instead.
		const shortcut = new TestShortcut();
		shortcut.register("Alt+Shift+O", () => undefined);
		const app = new DesktopApplication({
			platform: "win32",
			ports: { ...ports(), shortcut },
			pi: new FakeAgentRuntime(),
			metadata: new MemoryMetadataRepository(),
		});
		await expect(app.initialize()).resolves.toBeDefined();
		expect(app.getState().diagnostics.some((d) => d.component === "shortcut")).toBe(true);
	});

	it("keeps a new session out of history until Pi has produced a reply", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new FakeAgentRuntime({ response: "completed" }),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		await app.dispatch({ type: "projects.add", rootPath: root });
		expect(app.getState().conversations).toHaveLength(0);
		await app.dispatch({ type: "agent.prompt", text: "draft title" });
		await Promise.resolve();
		await Promise.resolve();
		expect(app.getState().conversations).toEqual([expect.objectContaining({ title: "draft title" })]);
	});

	it("promotes a draft after Pi persists the assistant response", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new FakeAgentRuntime({ response: "completed" }),
			metadata: new MemoryMetadataRepository(),
			sessionFiles: new DelayedSessionFiles(),
		});
		await app.initialize();
		await app.dispatch({ type: "projects.add", rootPath: root });
		await app.dispatch({ type: "agent.prompt", text: "delayed persistence" });
		await vi.waitFor(() => expect(app.getState().conversations).toHaveLength(1));
	});

	it("uses the global shortcut as a window toggle", async () => {
		const shortcut = new TestShortcut();
		const window = new TestWindow();
		const app = new DesktopApplication({
			platform: "win32",
			ports: { ...ports(), shortcut, window },
			pi: new FakeAgentRuntime(),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		shortcut.trigger("Alt+Shift+O");
		expect(window.getState().visible).toBe(false);
	});

	it("applies close-to-tray settings to the window port", async () => {
		const window = new TestWindow();
		const app = new DesktopApplication({
			platform: "win32",
			ports: { ...ports(), window },
			pi: new FakeAgentRuntime(),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		expect(window.getState().closeToTray).toBe(true);
		const response = await app.dispatch({ type: "settings.update", patch: { closeToTray: false } });
		expect(response.success).toBe(true);
		expect(window.getState().closeToTray).toBe(false);
	});

	it("restarts the active runtime when Skill directories change", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-project-"));
		const skillDirectory = await mkdtemp(join(tmpdir(), "pi-desktop-skill-"));
		const runtime = new RecordingRuntime();
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: runtime,
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		await app.dispatch({ type: "projects.add", rootPath: root });
		expect(runtime.starts).toHaveLength(1);
		const response = await app.dispatch({ type: "settings.update", patch: { skillDirectories: [skillDirectory] } });
		expect(response.success).toBe(true);
		expect(runtime.starts).toHaveLength(2);
		expect(runtime.starts.at(-1)?.skillDirectories).toEqual([await realpath(skillDirectory)]);
	});

	it("uses model and thinking defaults for new conversations", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const metadata = new MemoryMetadataRepository();
		await metadata.saveModel({
			id: "model-1",
			providerId: "provider",
			displayName: "First model",
			baseUrl: "https://example.test/v1",
			modelId: "model-1",
			credentialRef: null,
			enabled: true,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new FakeAgentRuntime(),
			metadata,
		});
		await app.initialize();
		expect(app.getState().settings.defaultModelProfileId).toBe("model-1");
		expect(app.getState().settings.theme).toBe("dark");
		const themeResponse = await app.dispatch({ type: "settings.update", patch: { theme: "light" } });
		expect(themeResponse.success).toBe(true);
		expect(app.getState().settings.theme).toBe("light");
		await app.dispatch({ type: "projects.add", rootPath: root });
		expect(app.getState().runtime).toEqual(
			expect.objectContaining({ modelProvider: "provider", modelId: "model-1", thinkingLevel: "high" }),
		);
		await app.dispatch({ type: "settings.update", patch: { defaultThinkingLevel: "medium" } });
		expect(app.getState().settings).toEqual(
			expect.objectContaining({ conversationFontSize: 16, sidebarFontSize: 14 }),
		);
		const fontResponse = await app.dispatch({
			type: "settings.update",
			patch: { conversationFontSize: 20, sidebarFontSize: 12 },
		});
		expect(fontResponse.success).toBe(true);
		expect(app.getState().settings).toEqual(
			expect.objectContaining({ conversationFontSize: 20, sidebarFontSize: 12 }),
		);
		await app.dispatch({ type: "agent.setThinkingLevel", level: "low" });
		expect(app.getState().runtime?.thinkingLevel).toBe("low");
		await app.dispatch({ type: "sessions.create", projectId: app.getState().activeProjectId ?? "" });
		expect(app.getState().runtime?.thinkingLevel).toBe("medium");
		expect(app.getState().runtime?.availableThinkingLevels).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
	});

	it("falls back from a deleted session model and repairs the conversation index", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const metadata = new MemoryMetadataRepository();
		const timestamp = "2026-08-01T00:00:00.000Z";
		await metadata.saveProject({
			id: "project-1",
			name: "Project",
			rootPath: root,
			trustState: "trusted",
			createdAt: timestamp,
			updatedAt: timestamp,
			lastOpenedAt: timestamp,
		});
		await metadata.saveModel({
			id: "model-old",
			providerId: "old-provider",
			displayName: "Old model",
			baseUrl: "https://old.example.test/v1",
			modelId: "old-model",
			credentialRef: null,
			enabled: true,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await metadata.saveModel({
			id: "model-new",
			providerId: "new-provider",
			displayName: "New model",
			baseUrl: "https://new.example.test/v1",
			modelId: "new-model",
			credentialRef: null,
			enabled: true,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await metadata.saveSettings({
			...(await metadata.loadSettings()),
			defaultModelProfileId: "model-old",
		});
		await metadata.saveConversation({
			id: "session-1",
			projectId: "project-1",
			sessionPath: join(root, "session-1.jsonl"),
			title: "Existing conversation",
			createdAt: timestamp,
			updatedAt: timestamp,
			modelProvider: "old-provider",
			modelId: "old-model",
			thinkingLevel: "high",
			leafId: null,
			status: "idle",
		});
		const runtime = new RecordingRuntime();
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: runtime,
			metadata,
		});
		await app.initialize();
		await app.dispatch({ type: "projects.select", projectId: "project-1" });

		const response = await app.dispatch({ type: "models.delete", profileId: "model-old" });

		expect(response.success).toBe(true);
		expect(runtime.starts.at(-1)?.selectedModel).toEqual({ providerId: "new-provider", modelId: "new-model" });
		expect(app.getState().settings.defaultModelProfileId).toBe("model-new");
		expect(app.getState().runtime).toEqual(
			expect.objectContaining({ status: "ready", modelProvider: "new-provider", modelId: "new-model" }),
		);
		expect(await metadata.listConversations("project-1")).toEqual([
			expect.objectContaining({ modelProvider: "new-provider", modelId: "new-model" }),
		]);
	});

	it("clamps the default thinking level to the active model's supported levels", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new FakeAgentRuntime({ availableThinkingLevels: ["off", "minimal", "low", "medium", "high"] }),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		await app.dispatch({ type: "settings.update", patch: { defaultThinkingLevel: "max" } });
		await app.dispatch({ type: "projects.add", rootPath: root });
		expect(app.getState().runtime?.availableThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
		await app.dispatch({ type: "agent.setThinkingLevel", level: "xhigh" });
		expect(app.getState().runtime?.thinkingLevel).toBe("high");
		await app.dispatch({ type: "sessions.create", projectId: app.getState().activeProjectId ?? "" });
		expect(app.getState().runtime?.thinkingLevel).toBe("high");
		expect(app.getState().settings.defaultThinkingLevel).toBe("max");
	});

	it("auto-enables DeepSeek built-in search when the active model is DeepSeek", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const metadata = new MemoryMetadataRepository();
		const secrets = new MemorySecretStore();
		const credentialRef = await secrets.set("sk-deepseek-1");
		await metadata.saveModel({
			id: "model-ds",
			providerId: "deepseek",
			displayName: "DeepSeek",
			baseUrl: "https://api.deepseek.com",
			modelId: "deepseek-v4-flash",
			credentialRef,
			enabled: true,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		const runtime = new RecordingRuntime();
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: runtime,
			metadata,
			secrets,
			webSearchExtensionPath: "C:\\extensions\\web-search.ts",
		});
		await app.initialize();
		await app.dispatch({ type: "projects.add", rootPath: root });
		const start = runtime.starts.at(-1);
		expect(start?.extensionPaths).toEqual(["C:\\extensions\\web-search.ts"]);
		expect(start?.env).toEqual(
			expect.objectContaining({
				PI_DESKTOP_WEB_SEARCH_PROVIDER: "deepseek",
				PI_DESKTOP_WEB_SEARCH_DEEPSEEK_BASE_URL: "https://api.deepseek.com",
				PI_DESKTOP_WEB_SEARCH_DEEPSEEK_MODEL: "deepseek-v4-flash",
				PI_DESKTOP_WEB_SEARCH_DEEPSEEK_API_KEY: "sk-deepseek-1",
			}),
		);
		expect(start?.sensitiveValues).toContain("sk-deepseek-1");
	});

	it("detects DeepSeek models by base URL and skips non-DeepSeek models", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const metadata = new MemoryMetadataRepository();
		const secrets = new MemorySecretStore();
		const deepseekRef = await secrets.set("sk-deepseek-2");
		await metadata.saveModel({
			id: "model-custom-ds",
			providerId: "my-gateway",
			displayName: "DeepSeek via gateway",
			baseUrl: "https://api.deepseek.com/",
			modelId: "deepseek-v4-flash",
			credentialRef: deepseekRef,
			enabled: true,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		const deepseekRuntime = new RecordingRuntime();
		const deepseekApp = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: deepseekRuntime,
			metadata,
			secrets,
			webSearchExtensionPath: "C:\\extensions\\web-search.ts",
		});
		await deepseekApp.initialize();
		await deepseekApp.dispatch({ type: "projects.add", rootPath: root });
		expect(deepseekRuntime.starts.at(-1)?.env.PI_DESKTOP_WEB_SEARCH_PROVIDER).toBe("deepseek");
		expect(deepseekRuntime.starts.at(-1)?.env.PI_DESKTOP_WEB_SEARCH_DEEPSEEK_BASE_URL).toBe(
			"https://api.deepseek.com",
		);
	});

	it("keeps web search disabled for non-DeepSeek models", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const metadata = new MemoryMetadataRepository();
		await metadata.saveModel({
			id: "model-openai",
			providerId: "openai",
			displayName: "OpenAI",
			baseUrl: "https://api.openai.com/v1",
			modelId: "gpt-5.5",
			credentialRef: null,
			enabled: true,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		const runtime = new RecordingRuntime();
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: runtime,
			metadata,
			webSearchExtensionPath: "C:\\extensions\\web-search.ts",
		});
		await app.initialize();
		await app.dispatch({ type: "projects.add", rootPath: root });
		const start = runtime.starts.at(-1);
		expect(start?.env.PI_DESKTOP_WEB_SEARCH_PROVIDER).toBeUndefined();
		expect(start?.env.BRAVE_SEARCH_API_KEY).toBeUndefined();
		expect(start?.env.TAVILY_API_KEY).toBeUndefined();
		expect(start?.extensionPaths).toEqual([]);
	});

	it("keeps an explicit Brave provider even when a DeepSeek model is active", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const metadata = new MemoryMetadataRepository();
		const secrets = new MemorySecretStore();
		const deepseekRef = await secrets.set("sk-deepseek-3");
		await metadata.saveModel({
			id: "model-ds",
			providerId: "deepseek",
			displayName: "DeepSeek",
			baseUrl: "https://api.deepseek.com",
			modelId: "deepseek-v4-flash",
			credentialRef: deepseekRef,
			enabled: true,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		const runtime = new RecordingRuntime();
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: runtime,
			metadata,
			secrets,
			webSearchExtensionPath: "C:\\extensions\\web-search.ts",
		});
		await app.initialize();
		await app.dispatch({ type: "webSearch.update", provider: "brave", apiKey: "bsk-brave-1" });
		await app.dispatch({ type: "projects.add", rootPath: root });
		const start = runtime.starts.at(-1);
		expect(start?.env.BRAVE_SEARCH_API_KEY).toBe("bsk-brave-1");
		expect(start?.env.PI_DESKTOP_WEB_SEARCH_PROVIDER).toBeUndefined();
		expect(start?.extensionPaths).toEqual(["C:\\extensions\\web-search.ts"]);
	});

	it("accepts the DeepSeek provider without a stored credential", async () => {
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new FakeAgentRuntime(),
			metadata: new MemoryMetadataRepository(),
		});
		await app.initialize();
		const response = await app.dispatch({ type: "webSearch.update", provider: "deepseek" });
		expect(response.success).toBe(true);
		expect(app.getState().settings.webSearch).toEqual({ provider: "deepseek", credentialRef: null });
	});

	it("restores the full transcript after Pi compaction makes the runtime context sparse", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-"));
		const sessionPath = join(root, ".pi-desktop", "sessions", "compacted.jsonl");
		const transcript: DesktopMessage[] = [
			{
				id: "file-user-1",
				role: "user",
				parts: [{ type: "text", text: "generate an html resume" }],
				createdAt: "2026-08-11T00:00:01.000Z",
				status: "finished",
			},
			{
				id: "file-assistant-1",
				role: "assistant",
				parts: [
					{
						type: "tool",
						text: '{"path":"index.html"}',
						toolName: "write",
						toolCallId: "call_1",
						status: "finished",
					},
					{
						type: "tool",
						text: "Successfully wrote 1024 bytes to index.html",
						toolName: "write",
						toolCallId: "call_1",
						status: "finished",
					},
					{ type: "text", text: "done the artistic html" },
				],
				createdAt: "2026-08-11T00:00:02.000Z",
				status: "finished",
			},
			{
				id: "file-user-2",
				role: "user",
				parts: [{ type: "text", text: "follow up" }],
				createdAt: "2026-08-11T00:00:03.000Z",
				status: "finished",
			},
			{
				id: "file-assistant-2",
				role: "assistant",
				parts: [{ type: "text", text: "final answer" }],
				createdAt: "2026-08-11T00:00:04.000Z",
				status: "finished",
			},
		];
		// Pi only serves the compacted context: the compaction summary (which the
		// desktop normalizes to an empty tool part) plus the recent tail.
		const compacted: DesktopMessage[] = [
			{
				id: "summary-1",
				role: "tool",
				parts: [{ type: "text", text: "" }],
				createdAt: "2026-08-11T00:00:05.000Z",
				status: "finished",
			},
			copyMessage(transcript[3]),
		];
		const app = new DesktopApplication({
			platform: "win32",
			ports: ports(),
			pi: new CompactedRuntime(sessionPath, compacted),
			metadata: new MemoryMetadataRepository(),
			sessionFiles: new TranscriptSessionFiles(sessionPath, transcript),
		});
		await app.initialize();
		await app.dispatch({ type: "projects.add", rootPath: root });
		expect(
			app
				.getState()
				.messages.some(
					(message) => message.role === "user" && message.parts[0]?.text === "generate an html resume",
				),
		).toBe(true);
		expect(
			app
				.getState()
				.messages.some((message) =>
					message.parts.some((part) => part.type === "tool" && part.text.includes("Successfully wrote")),
				),
		).toBe(true);
		expect(
			app.getState().messages.some((message) => message.parts.some((part) => part.text === "final answer")),
		).toBe(true);
		expect(
			app
				.getState()
				.messages.some(
					(message) => message.role === "tool" && message.parts.every((part) => part.text.trim() === ""),
				),
		).toBe(false);

		// Switching to a new session and back must keep showing the full transcript.
		const firstSessionId = app.getState().conversations[0].id;
		const activeProjectId = app.getState().activeProjectId;
		expect(activeProjectId).not.toBeNull();
		await app.dispatch({ type: "sessions.create", projectId: activeProjectId ?? "" });
		await app.dispatch({ type: "sessions.open", sessionId: firstSessionId });
		const restored = app.getState().messages;
		expect(
			restored.some((message) => message.role === "user" && message.parts[0]?.text === "generate an html resume"),
		).toBe(true);
		expect(
			restored.some((message) =>
				message.parts.some((part) => part.type === "tool" && part.text.includes("Successfully wrote")),
			),
		).toBe(true);
		expect(restored.some((message) => message.parts.some((part) => part.text === "final answer"))).toBe(true);
		expect(
			restored.some((message) => message.role === "tool" && message.parts.every((part) => part.text.trim() === "")),
		).toBe(false);
	});
});
