import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DesktopApplication, FakeAgentRuntime, MemoryMetadataRepository, MemorySecretStore } from "../src/index.ts";
import type { DesktopHostPorts } from "../src/ports.ts";
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

function ports(): DesktopHostPorts {
	return {
		window: new TestWindow(),
		tray: new TestTray(),
		shortcut: new TestShortcut(),
		singleInstance: new TestSingleInstance(),
	};
}

describe("desktop application", () => {
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
});
