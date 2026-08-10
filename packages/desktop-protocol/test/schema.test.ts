import { describe, expect, it } from "vitest";
import { isDesktopCommand, parseDesktopRequest } from "../src/index.ts";

describe("desktop protocol schema", () => {
	it("accepts typed commands and rejects malformed requests", () => {
		expect(isDesktopCommand({ type: "agent.prompt", text: "hello" })).toBe(true);
		expect(isDesktopCommand({ type: "agent.prompt", text: "" })).toBe(false);
		expect(parseDesktopRequest({ requestId: "req-1", command: { type: "window.show" } })).toEqual({
			requestId: "req-1",
			command: { type: "window.show" },
		});
		expect(() => parseDesktopRequest({ requestId: "", command: { type: "window.show" } })).toThrow(
			"Invalid desktop request",
		);
	});

	it("validates project, model, and skill commands", () => {
		expect(isDesktopCommand({ type: "projects.addFromFolder" })).toBe(true);
		expect(isDesktopCommand({ type: "projects.setTrust", projectId: "project-1", trustState: "trusted" })).toBe(true);
		expect(
			isDesktopCommand({
				type: "models.create",
				profile: {
					providerId: "provider",
					displayName: "Example",
					baseUrl: "https://example.test/v1",
					modelId: "model",
					enabled: true,
				},
				apiKey: "secret",
			}),
		).toBe(true);
		expect(isDesktopCommand({ type: "skills.reload" })).toBe(true);
		expect(isDesktopCommand({ type: "mcp.consent.revoke", projectId: "project-1" })).toBe(true);
		expect(isDesktopCommand({ type: "mcp.consent.revoke", projectId: "" })).toBe(false);
		expect(isDesktopCommand({ type: "models.create", profile: { providerId: "provider" } })).toBe(false);
	});
});
