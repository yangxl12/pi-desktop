import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionStore, PiSessionCodec } from "../src/index.ts";

describe("session codec and store", () => {
	it("reads Pi JSONL messages and exposes a paged, opaque session store", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-session-store-"));
		const path = join(directory, "session.jsonl");
		await writeFile(
			path,
			[
				JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-08-02T00:00:00.000Z" }),
				JSON.stringify({
					type: "message",
					id: "message-1",
					timestamp: 1,
					message: { role: "user", content: "hello" },
				}),
			].join("\n"),
		);
		const codec = new PiSessionCodec();
		const store = new FileSessionStore(codec);
		const summary = await store.readSummary({
			runtimeProviderId: "pi",
			backendId: "filesystem",
			codecId: codec.id,
			opaqueRef: path,
		});
		expect(summary.historyAccess).toBe("continue");
		expect((await store.readMessages(path))[0]?.parts[0]?.text).toBe("hello");
		expect((await store.list(directory, { projectId: "project", limit: 1 })).items[0]).toMatchObject({
			id: "session-1",
			projectId: "project",
			runtimeProviderId: "pi",
		});
	});
});
