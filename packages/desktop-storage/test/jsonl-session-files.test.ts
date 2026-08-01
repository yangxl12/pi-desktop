import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSessionFileRepository } from "../src/session-files.ts";

describe("Pi session file repository", () => {
	it("rebuilds session metadata from Pi JSONL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-sessions-"));
		const sessionPath = join(directory, "session.jsonl");
		await writeFile(
			sessionPath,
			[
				JSON.stringify({ type: "session", id: "pi-session", timestamp: "2026-08-01T00:00:00.000Z" }),
				JSON.stringify({
					type: "message",
					id: "user-1",
					timestamp: "2026-08-01T00:01:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "First prompt" }] },
				}),
				JSON.stringify({
					type: "model_change",
					id: "model-1",
					timestamp: "2026-08-01T00:02:00.000Z",
					provider: "openai-compatible",
					modelId: "example-model",
				}),
				JSON.stringify({
					type: "thinking_level_change",
					id: "thinking-1",
					timestamp: "2026-08-01T00:03:00.000Z",
					thinkingLevel: "high",
				}),
				JSON.stringify({
					type: "session_info",
					id: "name-1",
					timestamp: "2026-08-01T00:04:00.000Z",
					name: "Renamed conversation",
				}),
			].join("\n"),
			"utf8",
		);

		const result = await new PiSessionFileRepository().scan(directory);

		expect(result.diagnostics).toEqual([]);
		expect(result.sessions).toEqual([
			expect.objectContaining({
				id: "pi-session",
				sessionPath,
				title: "Renamed conversation",
				modelProvider: "openai-compatible",
				modelId: "example-model",
				thinkingLevel: "high",
				leafId: "name-1",
			}),
		]);
	});

	it("keeps valid sessions and reports invalid JSONL diagnostics", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-sessions-"));
		await writeFile(
			join(directory, "valid.jsonl"),
			JSON.stringify({ type: "session", id: "valid", timestamp: "2026-08-01T00:00:00.000Z" }),
			"utf8",
		);
		await writeFile(join(directory, "invalid.jsonl"), "{invalid", "utf8");

		const result = await new PiSessionFileRepository().scan(directory);

		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.id).toBe("valid");
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]).toContain("invalid.jsonl");
	});
});
