import { describe, expect, it, vi } from "vitest";
import { createDesktopManagementTools } from "../src/desktop-management-tools.ts";
import type { McpPort } from "../src/ports.ts";
import type { SkillInstallService } from "../src/skill-install-service.ts";

function skillService() {
	const install = vi.fn(async () => ({ id: "skill-1", status: "loaded" }));
	return {
		install,
		service: {
			list: async () => [],
			inspect: async () => ({
				source: { kind: "npm", spec: "example-skill" },
				name: "example",
				description: "Example",
				version: "1.0.0",
				path: null,
				diagnostics: [],
				risk: ["Runs third-party code"],
			}),
			install,
			remove: async () => undefined,
		} as unknown as SkillInstallService,
	};
}

describe("desktop management tools", () => {
	it("requires application approval before installing a Skill", async () => {
		const denied = skillService();
		const deniedTool = createDesktopManagementTools({
			skills: denied.service,
			approve: async () => false,
		}).find((tool) => tool.name === "desktop_install_skill");
		await expect(deniedTool?.call({ kind: "npm", spec: "example-skill" })).rejects.toThrow("denied");
		expect(denied.install).not.toHaveBeenCalled();

		const approved = skillService();
		const previews: unknown[] = [];
		const approvedTool = createDesktopManagementTools({
			skills: approved.service,
			approve: async (preview) => {
				previews.push(preview);
				return true;
			},
		}).find((tool) => tool.name === "desktop_install_skill");
		await expect(approvedTool?.call({ kind: "npm", spec: "example-skill" })).resolves.toBeDefined();
		expect(approved.install).toHaveBeenCalledOnce();
		expect(previews).toEqual([expect.objectContaining({ operation: "skill.install" })]);
	});

	it("requires application approval before updating an MCP server", async () => {
		const update = vi.fn(async () => ({ status: "ready" }));
		const previews: unknown[] = [];
		const tool = createDesktopManagementTools({
			mcp: {
				list: () => [
					{
						profile: { id: "demo", name: "Demo" },
					},
				],
			} as unknown as McpPort,
			updateMcp: update,
			approve: async (preview) => {
				previews.push(preview);
				return true;
			},
		}).find((candidate) => candidate.name === "desktop_update_mcp_server");

		await expect(tool?.call({ serverId: "demo", patch: { enabled: false } })).resolves.toBeDefined();
		expect(update).toHaveBeenCalledWith("demo", { enabled: false });
		expect(previews).toEqual([expect.objectContaining({ operation: "mcp.update" })]);
	});
});
