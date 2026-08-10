import { describe, expect, it } from "vitest";
import { rendererContentType } from "../src/host/static-content.ts";

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
