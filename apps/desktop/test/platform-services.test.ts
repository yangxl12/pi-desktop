import { describe, expect, it } from "vitest";
import { windowsFolderPickerScript } from "../src/host/platform-services.ts";

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
