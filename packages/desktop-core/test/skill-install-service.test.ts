import type { SkillInstallationSnapshot } from "@earendil-works/pi-desktop-protocol";
import { describe, expect, it, vi } from "vitest";
import { MemoryMetadataRepository } from "../src/memory-repository.ts";
import type { SkillPackagePort } from "../src/ports.ts";
import { SkillInstallService } from "../src/skill-install-service.ts";

const installation: SkillInstallationSnapshot = {
	id: "skill_review",
	name: "review",
	description: "Review code",
	source: { kind: "local", spec: "C:/skills/review" },
	scope: "global",
	path: "C:/skills/review",
	version: null,
	status: "installed",
	commandName: "skill:review",
	diagnostics: [],
	operationId: null,
	installedAt: "2026-08-05T00:00:00.000Z",
	updatedAt: "2026-08-05T00:00:00.000Z",
};

function port(overrides: Partial<SkillPackagePort> = {}): SkillPackagePort {
	return {
		inspect: async ({ source }) => ({
			source,
			name: "review",
			description: "Review code",
			version: null,
			path: installation.path,
			diagnostics: [],
			risk: [],
		}),
		install: async () => ({ ...installation, diagnostics: [], source: { ...installation.source } }),
		remove: async () => undefined,
		list: async () => [],
		reconcile: async () => [{ ...installation, diagnostics: [], source: { ...installation.source } }],
		...overrides,
	};
}

describe("SkillInstallService", () => {
	it("rolls back settings/files and restarts the previous runtime when get_commands misses the Skill", async () => {
		const metadata = new MemoryMetadataRepository();
		const rollback = vi.fn(async () => undefined);
		const commit = vi.fn(async () => undefined);
		const reload = vi.fn(async () => [] as const);
		const service = new SkillInstallService({
			port: port({ rollback, commit }),
			metadata,
			onReload: reload,
		});

		await expect(service.install(installation.source, "global", "missing-command")).rejects.toThrow(
			"Pi runtime did not expose the Skill command",
		);
		expect(rollback).toHaveBeenCalledWith("missing-command");
		expect(commit).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledTimes(2);
		expect(await metadata.listSkillInstallations()).toEqual([]);
	});

	it("commits only after the runtime returns the expected Skill command", async () => {
		const commit = vi.fn(async () => undefined);
		const rollback = vi.fn(async () => undefined);
		const service = new SkillInstallService({
			port: port({ commit, rollback }),
			onReload: async () => [{ name: "skill:review", source: "skill" }],
		});

		await expect(service.install(installation.source, "global", "loaded-command")).resolves.toMatchObject({
			status: "loaded",
			commandName: "skill:review",
		});
		expect(commit).toHaveBeenCalledWith("loaded-command");
		expect(rollback).not.toHaveBeenCalled();
	});

	it("rolls back a prepared removal when the restarted runtime still exposes the Skill", async () => {
		const metadata = new MemoryMetadataRepository();
		await metadata.saveSkillInstallation(installation);
		const prepareRemove = vi.fn(async () => undefined);
		const rollback = vi.fn(async () => undefined);
		const commit = vi.fn(async () => undefined);
		const reload = vi.fn(async () => [{ name: "skill:review", source: "skill" }]);
		const service = new SkillInstallService({
			port: port({ prepareRemove, rollback, commit }),
			metadata,
			onReload: reload,
		});

		await expect(service.remove(installation, "remove-still-loaded")).rejects.toThrow(
			"Pi runtime still exposes the removed Skill command",
		);
		expect(prepareRemove).toHaveBeenCalledWith(installation, "remove-still-loaded", expect.any(Function));
		expect(rollback).toHaveBeenCalledWith("remove-still-loaded");
		expect(commit).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledTimes(2);
		expect(await metadata.listSkillInstallations()).toHaveLength(1);
	});

	it("commits a prepared removal only after the command disappears from the runtime", async () => {
		const metadata = new MemoryMetadataRepository();
		await metadata.saveSkillInstallation(installation);
		const prepareRemove = vi.fn(async () => undefined);
		const rollback = vi.fn(async () => undefined);
		const commit = vi.fn(async () => undefined);
		const service = new SkillInstallService({
			port: port({ prepareRemove, rollback, commit }),
			metadata,
			onReload: async () => [],
		});

		await expect(service.remove(installation, "remove-loaded")).resolves.toBeUndefined();
		expect(prepareRemove).toHaveBeenCalledWith(installation, "remove-loaded", expect.any(Function));
		expect(commit).toHaveBeenCalledWith("remove-loaded");
		expect(rollback).not.toHaveBeenCalled();
		expect(await metadata.listSkillInstallations()).toEqual([]);
	});
});
