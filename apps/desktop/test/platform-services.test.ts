import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlatformSecretStore, windowsFolderPickerScript } from "../src/host/platform-services.ts";

describe("native folder picker (win32)", () => {
	it("forces UTF-8 stdout so non-ASCII folder paths survive the PowerShell pipe", () => {
		// Regression: PowerShell 5.1 writes redirected stdout in the system code
		// page (GBK on zh-CN); without the preset, a picked path such as
		// D:\项目 gets mangled and adding a project fails with NOT_FOUND.
		const script = windowsFolderPickerScript();
		expect(script).toContain("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8");
	});

	it("still selects via the Shell.Application COM dialog and emits the picked path", () => {
		const script = windowsFolderPickerScript();
		expect(script).toContain("BrowseForFolder");
		expect(script).toContain("$folder.Self.Path");
	});
});

describe("Windows credential protection", () => {
	it("uses Electron secure storage when the shell port is available", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-desktop-secrets-"));
		const protection = {
			protect: vi.fn(async (value: string) => Buffer.from(value).toString("base64")),
			unprotect: vi.fn(async (value: string) => Buffer.from(value, "base64").toString("utf8")),
		};
		const store = new PlatformSecretStore(directory, "win32", protection);

		const ref = await store.set("api-key", "model-key");
		await expect(store.get(ref)).resolves.toBe("api-key");
		expect(protection.protect).toHaveBeenCalledWith("api-key");
		expect(protection.unprotect).toHaveBeenCalledWith("YXBpLWtleQ==");
		expect(await readFile(join(directory, "secrets.json"), "utf8")).not.toContain("api-key");
	});
});
