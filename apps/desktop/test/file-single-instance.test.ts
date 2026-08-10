import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSingleInstancePort } from "../src/host/file-single-instance.ts";

const directories: string[] = [];

function tempDirectory(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-desktop-lock-")).then((directory) => {
		directories.push(directory);
		return directory;
	});
}

function portFor(directory: string): FileSingleInstancePort {
	return new FileSingleInstancePort(directory);
}

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("file single instance lock", () => {
	it("acquires when no lock exists", async () => {
		const port = portFor(await tempDirectory());
		expect(await port.acquire(() => {})).toBe(true);
	});

	it("refuses when another live process holds the lock", async () => {
		const directory = await tempDirectory();
		const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		try {
			await writeFile(join(directory, "desktop.lock"), String(holder.pid), "utf8");
			const port = portFor(directory);
			expect(await port.acquire(() => {})).toBe(false);
			expect(await readFile(join(directory, "desktop.lock"), "utf8")).toBe(String(holder.pid));
		} finally {
			holder.kill();
		}
	});

	it("reclaims a stale lock from a dead process", async () => {
		const directory = await tempDirectory();
		await writeFile(join(directory, "desktop.lock"), "4294967295", "utf8");
		const port = portFor(directory);
		expect(await port.acquire(() => {})).toBe(true);
		expect(await readFile(join(directory, "desktop.lock"), "utf8")).toBe(String(process.pid));
		await port.release();
	});

	it("reclaims a stale lock whose pid was reused by the current process", async () => {
		const directory = await tempDirectory();
		await writeFile(join(directory, "desktop.lock"), String(process.pid), "utf8");
		const port = portFor(directory);
		expect(await port.acquire(() => {})).toBe(true);
		expect(await readFile(join(directory, "desktop.lock"), "utf8")).toBe(String(process.pid));
		await port.release();
	});
});
