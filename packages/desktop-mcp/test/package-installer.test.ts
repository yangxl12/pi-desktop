import { describe, expect, it } from "vitest";
import { parseNpmPackageSpec, parseNpxCommand } from "../src/package-installer.ts";

describe("managed npm import", () => {
	it("normalizes npx package and server arguments", () => {
		expect(parseNpxCommand("npx", ["-y", "@modelcontextprotocol/server-filesystem@1.2.3", "C:/data"])).toEqual({
			packageSpec: "@modelcontextprotocol/server-filesystem@1.2.3",
			version: "1.2.3",
			args: ["C:/data"],
		});
		expect(parseNpxCommand("npx.cmd", ["example-server", "--stdio"])).toEqual({
			packageSpec: "example-server",
			version: null,
			args: ["--stdio"],
		});
	});

	it("separates scoped package names from exact versions", () => {
		expect(parseNpmPackageSpec("@scope/server@4.5.6")).toEqual({ name: "@scope/server", version: "4.5.6" });
		expect(parseNpmPackageSpec("server")).toEqual({ name: "server", version: null });
		expect(() => parseNpmPackageSpec("https://example.test/server.tgz")).toThrow("Unsupported");
	});
});
