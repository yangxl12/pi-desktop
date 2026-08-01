import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteMetadataRepository } from "../src/sqlite-repository.ts";

describe("SQLite metadata repository", () => {
	it("migrates and persists projects, conversations, models, and settings", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-database-"));
		const databasePath = join(directory, "desktop.sqlite");
		const repository = new SqliteMetadataRepository(databasePath);
		await repository.initialize();

		await repository.saveProject({
			id: "project-1",
			name: "Example",
			rootPath: directory,
			trustState: "trusted",
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
			lastOpenedAt: null,
		});
		await repository.saveConversation({
			id: "conversation-1",
			projectId: "project-1",
			sessionPath: join(directory, "conversation.jsonl"),
			title: "Conversation",
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:01:00.000Z",
			modelProvider: "provider",
			modelId: "model",
			thinkingLevel: "medium",
			leafId: "leaf-1",
			status: "idle",
		});
		await repository.saveModel({
			id: "model-1",
			providerId: "provider",
			displayName: "Example model",
			baseUrl: "https://example.test/v1",
			modelId: "model",
			credentialRef: "secret:model-1",
			enabled: true,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		const settings = await repository.loadSettings();
		await repository.saveSettings({
			...settings,
			defaultModelProfileId: "model-1",
			skillDirectories: [join(directory, "skills")],
		});
		await repository.close();

		const reopened = new SqliteMetadataRepository(databasePath);
		await reopened.initialize();
		expect(await reopened.listProjects()).toEqual([expect.objectContaining({ id: "project-1" })]);
		expect(await reopened.listConversations("project-1")).toEqual([
			expect.objectContaining({ id: "conversation-1", thinkingLevel: "medium" }),
		]);
		expect(await reopened.listModels()).toEqual([
			expect.objectContaining({ id: "model-1", credentialRef: "secret:model-1" }),
		]);
		expect(await reopened.loadSettings()).toEqual(
			expect.objectContaining({
				defaultModelProfileId: "model-1",
				skillDirectories: [join(directory, "skills")],
			}),
		);
		await reopened.close();
	});
});
