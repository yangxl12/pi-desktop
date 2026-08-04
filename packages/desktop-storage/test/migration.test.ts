import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionMigrationReport, PiSessionCodec } from "../src/index.ts";

describe("session migration report", () => {
	it("classifies Pi sessions without rewriting the JSONL source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-migration-"));
		const path = join(directory, "session.jsonl");
		const original = `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-08-02T00:00:00.000Z" })}\n`;
		await writeFile(path, original, "utf8");
		const scan = await new PiSessionCodec().scan(directory);
		const report = createSessionMigrationReport([], [], scan);
		expect(report.sessions).toBe(1);
		expect(report.invalid).toBe(1);
		expect(report.entries[0]?.status).toBe("invalid");
		await expect((await import("node:fs/promises")).readFile(path, "utf8")).resolves.toBe(original);
	});
});
