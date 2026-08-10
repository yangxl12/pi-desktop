import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiSkillPackageAdapter } from "../src/skill-package-adapter.ts";

async function writeSkill(directory: string, name: string, description?: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	const frontmatter =
		description === undefined ? `---\nname: ${name}\n---` : `---\nname: ${name}\ndescription: ${description}\n---`;
	await writeFile(join(directory, "SKILL.md"), `${frontmatter}\n\nInstructions`, "utf8");
}

describe("PiSkillPackageAdapter", () => {
	it("rejects an invalid local package before it creates a managed target or settings entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-skill-invalid-"));
		const source = join(root, "source");
		const agentDir = join(root, "agent");
		await writeSkill(source, "invalid-description");
		const adapter = new PiSkillPackageAdapter({ cwd: root, agentDir, projectTrusted: true });

		await expect(
			adapter.install({ source: { kind: "local", spec: source }, scope: "global", operationId: "invalid-local" }),
		).rejects.toThrow("description");
		await expect(access(join(agentDir, "skills", "invalid-description"))).rejects.toThrow();
		expect(await adapter.list()).toEqual([]);
	});

	it("uses a staged local import and restores the previous directory when validation must roll back", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-skill-rollback-"));
		const source = join(root, "source");
		const agentDir = join(root, "agent");
		await writeSkill(source, "review", "Review the current project");
		const adapter = new PiSkillPackageAdapter({ cwd: root, agentDir, projectTrusted: true });

		const installation = await adapter.install({
			source: { kind: "local", spec: source },
			scope: "global",
			operationId: "rollback-local",
		});
		await expect(access(join(agentDir, "skills", "review", "SKILL.md"))).resolves.toBeUndefined();
		await adapter.rollback("rollback-local");
		await expect(access(join(agentDir, "skills", "review"))).rejects.toThrow();
		expect(await adapter.list()).toEqual([]);
		expect(installation.commandName).toBe("skill:review");
	});

	it("rejects a second source that declares an already-installed Skill name", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-skill-duplicate-"));
		const first = join(root, "first");
		const second = join(root, "second");
		const agentDir = join(root, "agent");
		await writeSkill(first, "review", "First description");
		await writeSkill(second, "review", "Second description");
		const adapter = new PiSkillPackageAdapter({ cwd: root, agentDir, projectTrusted: true });
		await adapter.install({ source: { kind: "local", spec: first }, scope: "global", operationId: "first" });
		await adapter.commit("first");

		await expect(
			adapter.install({ source: { kind: "local", spec: second }, scope: "global", operationId: "second" }),
		).rejects.toThrow("already installed");
	});

	it("records the configured Node/npm sidecar instead of falling back to system npm", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-skill-sidecar-"));
		const source = join(root, "source");
		const agentDir = join(root, "agent");
		await writeSkill(source, "review", "Review the current project");
		const adapter = new PiSkillPackageAdapter({
			cwd: root,
			agentDir,
			projectTrusted: true,
			npmCommand: ["C:/Pi Desktop/sidecar/node.exe", "C:/Pi Desktop/sidecar/npm-cli.js"],
		});

		await adapter.install({ source: { kind: "local", spec: source }, scope: "global", operationId: "sidecar" });
		const settings = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as { npmCommand?: string[] };
		expect(settings.npmCommand).toEqual(["C:/Pi Desktop/sidecar/node.exe", "C:/Pi Desktop/sidecar/npm-cli.js"]);
	});

	it("does not run managed package installation without a Node/npm sidecar", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-skill-no-sidecar-"));
		const adapter = new PiSkillPackageAdapter({ cwd: root, agentDir: join(root, "agent"), projectTrusted: true });

		await expect(
			adapter.install({
				source: { kind: "npm", spec: "example-skill" },
				scope: "global",
				operationId: "no-sidecar",
			}),
		).rejects.toThrow("Node/npm sidecar");
	});

	it("removes a project-managed local Skill from project settings and storage", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-desktop-skill-project-remove-"));
		const project = join(root, "project");
		const source = join(root, "source");
		await writeSkill(source, "review", "Review the current project");
		const adapter = new PiSkillPackageAdapter({ cwd: project, agentDir: join(root, "agent"), projectTrusted: true });

		await adapter.install({
			source: { kind: "local", spec: source },
			scope: "project",
			operationId: "project-skill",
		});
		await adapter.commit("project-skill");
		const installation = (await adapter.list("project")).find((item) => item.name === "review");
		expect(installation).toMatchObject({ source: { kind: "local" }, scope: "project" });
		if (!installation) throw new Error("Project Skill was not listed");

		await adapter.remove(installation);
		await expect(access(join(project, ".pi", "skills", "review"))).rejects.toThrow();
		expect(await adapter.list("project")).toEqual([]);
	});
});
