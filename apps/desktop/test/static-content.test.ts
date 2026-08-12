import { describe, expect, it } from "vitest";
import { previewFileContentType, rendererContentType } from "../src/host/static-content.ts";

describe("renderer content types", () => {
	it("serves ES module scripts with the JavaScript MIME type", () => {
		expect(rendererContentType("C:\\resources\\app\\renderer\\slash-menu.mjs")).toBe("text/javascript; charset=utf-8");
		expect(rendererContentType("/renderer/app.js")).toBe("text/javascript; charset=utf-8");
	});

	it("keeps the other renderer asset types intact", () => {
		expect(rendererContentType("index.html")).toBe("text/html; charset=utf-8");
		expect(rendererContentType("styles.css")).toBe("text/css; charset=utf-8");
		expect(rendererContentType("nested/folder/page.html")).toBe("text/html; charset=utf-8");
	});
});

describe("preview file content types", () => {
	it("maps the previewable formats to browser-friendly MIME types", () => {
		expect(previewFileContentType("docs/readme.md")).toBe("text/markdown; charset=utf-8");
		expect(previewFileContentType("index.html")).toBe("text/html; charset=utf-8");
		expect(previewFileContentType("data.json")).toBe("application/json; charset=utf-8");
		expect(previewFileContentType("pic.svg")).toBe("image/svg+xml; charset=utf-8");
		expect(previewFileContentType("chart.png")).toBe("image/png");
		expect(previewFileContentType("report.pdf")).toBe("application/pdf");
		expect(previewFileContentType("doc.docx")).toBe(
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		);
		expect(previewFileContentType("archive.zip")).toBe("application/zip");
	});

	it("falls back to octet-stream for unknown preview formats", () => {
		expect(previewFileContentType("bundle.exe")).toBe("application/octet-stream");
		expect(previewFileContentType("no-extension")).toBe("application/octet-stream");
	});
});
