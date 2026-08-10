import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	loadSkillsFromDir,
	type PackageSource,
	SettingsManager,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import type {
	SkillPackageInspection,
	SkillPackageInstallRequest,
	SkillPackagePort,
} from "@earendil-works/pi-desktop-core";
import type {
	SkillInstallationSnapshot,
	SkillInstallPhase,
	SkillInstallScope,
	SkillSource,
} from "@earendil-works/pi-desktop-protocol";

function installationId(source: SkillSource, scope: SkillInstallScope, name: string | null): string {
	return `skill_${Buffer.from(`${scope}:${source.kind}:${source.spec}:${name ?? ""}`).toString("base64url")}`.slice(
		0,
		96,
	);
}

function normalizeSource(source: SkillSource): string {
	if (source.kind === "npm") {
		const spec =
			source.version && !source.spec.endsWith(`@${source.version}`)
				? `${source.spec}@${source.version}`
				: source.spec;
		return spec.startsWith("npm:") ? spec : `npm:${spec}`;
	}
	if (source.kind === "git") {
		const spec = source.ref && !source.spec.endsWith(`@${source.ref}`) ? `${source.spec}@${source.ref}` : source.spec;
		return spec.startsWith("git:") ? spec : `git:${spec}`;
	}
	return source.spec;
}

async function installedVersion(path: string): Promise<string | null> {
	try {
		const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { version?: unknown };
		return typeof manifest.version === "string" ? manifest.version : null;
	} catch {
		return null;
	}
}

function skillFromDirectory(dir: string, source: string): Skill | undefined {
	const result = loadSkillsFromDir({ dir, source });
	return result.skills.find((skill) => basename(skill.filePath).toLowerCase() === "skill.md");
}

function skillDiagnostics(dir: string, source: string): string[] {
	const result = loadSkillsFromDir({ dir, source });
	const diagnostics = result.diagnostics.map((diagnostic) => diagnostic.message);
	const skill = result.skills.find((candidate) => basename(candidate.filePath).toLowerCase() === "skill.md");
	if (!skill) diagnostics.push("No valid SKILL.md found");
	else if (!skill.description.trim()) diagnostics.push("Skill description is required");
	else if (!isValidSkillName(skill.name)) diagnostics.push(`Invalid Skill name: ${skill.name}`);
	return [...new Set(diagnostics)];
}

function isValidSkillName(name: string): boolean {
	return name.length > 0 && name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

function loadedSkillDiagnostics(skill: Skill | undefined): string[] {
	if (!skill) return ["No valid SKILL.md found"];
	const diagnostics: string[] = [];
	if (!skill.description.trim()) diagnostics.push("Skill description is required");
	if (!isValidSkillName(skill.name)) diagnostics.push(`Invalid Skill name: ${skill.name}`);
	return diagnostics;
}

function isPathWithin(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

function assertPathWithin(root: string, candidate: string, label: string): void {
	if (!isPathWithin(root, candidate)) throw new Error(`${label} is outside the managed directory`);
}

function sourceKey(source: SkillSource): string {
	if (source.kind === "local" || source.kind === "external") return `${source.kind}:${resolve(source.spec)}`;
	return `${source.kind}:${normalizeSource(source)}`;
}

interface SettingsSnapshot {
	globalPackages: PackageSource[];
	projectPackages: PackageSource[];
	globalSkillPaths: string[];
	projectSkillPaths: string[];
	globalNpmCommand?: string[];
}

interface ManagedRootTransaction {
	targetRoot: string;
	stagingRoot: string;
	backupRoot: string;
	hadTarget: boolean;
}

interface SkillInstallTransaction {
	operationId: string;
	settings: SettingsSnapshot;
	externalPaths: string[];
	stagingParent?: string;
	stagingBoundary?: string;
	managedRoot?: ManagedRootTransaction;
	localRoot?: ManagedRootTransaction;
}

function snapshotFromSkill(
	source: SkillSource,
	scope: SkillInstallScope,
	skill: Skill | undefined,
	path: string | null,
	version: string | null,
	status: SkillInstallationSnapshot["status"] = "installed",
	diagnostics: string[] = [],
): SkillInstallationSnapshot {
	const updatedAt = new Date().toISOString();
	return {
		id: installationId(source, scope, skill?.name ?? null),
		name: skill?.name ?? null,
		description: skill?.description ?? null,
		source: { ...source },
		scope,
		path,
		version,
		status,
		commandName: skill ? `skill:${skill.name}` : null,
		diagnostics: [...diagnostics],
		operationId: null,
		installedAt: status === "error" ? null : updatedAt,
		updatedAt,
	};
}

/** Pi 0.83 package/skill boundary. Only skills are enabled for managed packages. */
export class PiSkillPackageAdapter implements SkillPackagePort {
	private cwd: string;
	private readonly agentDir: string;
	private projectTrusted: boolean;
	private readonly npmCommand: readonly string[] | undefined;
	private settings: ReturnType<typeof SettingsManager.create>;
	private manager: DefaultPackageManager;
	private externalPaths: string[] = [];
	private readonly transactions = new Map<string, SkillInstallTransaction>();
	private transactionQueue: Promise<void> = Promise.resolve();

	constructor(options: {
		cwd: string;
		agentDir: string;
		projectTrusted?: boolean;
		externalPaths?: string[];
		npmCommand?: readonly string[];
	}) {
		this.cwd = resolve(options.cwd);
		this.agentDir = resolve(options.agentDir);
		this.projectTrusted = options.projectTrusted ?? false;
		this.externalPaths = [...(options.externalPaths ?? [])];
		const command = options.npmCommand?.map((part) => part.trim());
		if (command && (command.length === 0 || command.some((part) => !part)))
			throw new Error("Configured npm sidecar command must not contain empty arguments");
		this.npmCommand = command;
		this.settings = this.createSettings();
		this.manager = this.createManager();
	}

	setContext(options: { cwd?: string; projectTrusted?: boolean; externalPaths?: string[] }): void {
		const nextCwd = options.cwd ? resolve(options.cwd) : this.cwd;
		const nextTrusted = options.projectTrusted ?? this.projectTrusted;
		const changed = nextCwd !== this.cwd || nextTrusted !== this.projectTrusted;
		this.cwd = nextCwd;
		this.projectTrusted = nextTrusted;
		if (options.externalPaths) this.externalPaths = [...options.externalPaths];
		if (changed) {
			this.settings = this.createSettings();
			this.manager = this.createManager();
		}
	}

	private createSettings(): ReturnType<typeof SettingsManager.create> {
		const settings = SettingsManager.create(this.cwd, this.agentDir, { projectTrusted: this.projectTrusted });
		if (this.npmCommand) settings.setNpmCommand([...this.npmCommand]);
		return settings;
	}

	private createManager(): DefaultPackageManager {
		return new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settings,
		});
	}

	async inspect(request: {
		source: SkillSource;
		scope: SkillInstallScope;
		localPath?: string;
	}): Promise<SkillPackageInspection> {
		const { source } = request;
		if (source.kind === "local" || source.kind === "external") {
			const path = resolve(request.localPath ?? source.spec);
			const loaded = skillFromDirectory(path, source.spec);
			return {
				source,
				name: loaded?.name ?? null,
				description: loaded?.description ?? null,
				version: null,
				path,
				diagnostics: skillDiagnostics(path, source.spec),
				risk: ["Reads local files"],
			};
		}
		return {
			source,
			name: null,
			description: null,
			version: source.version ?? source.ref ?? null,
			path: null,
			diagnostics: [],
			risk: ["Downloads and installs third-party package code"],
		};
	}

	install(
		request: SkillPackageInstallRequest,
		onProgress?: (phase: SkillInstallPhase, message?: string) => void,
	): Promise<SkillInstallationSnapshot> {
		return this.enqueueTransaction(() => this.installInternal(request, onProgress));
	}

	private async installInternal(
		request: SkillPackageInstallRequest,
		onProgress?: (phase: SkillInstallPhase, message?: string) => void,
	): Promise<SkillInstallationSnapshot> {
		const { source, scope, localPath } = request;
		onProgress?.("inspect");
		if (scope === "project" && !this.projectTrusted)
			throw new Error("Project must be trusted before installing a skill");
		if ((source.kind === "npm" || source.kind === "git") && !this.npmCommand)
			throw new Error("Managed Skill installation requires a configured Node/npm sidecar");
		if (this.transactions.size > 0) throw new Error("Another Skill installation is awaiting runtime validation");
		if (source.kind === "local")
			return this.importLocal(source, scope, localPath ?? source.spec, request.operationId, onProgress);
		if (source.kind === "external") {
			return this.importExternal(source, scope, localPath ?? source.spec, request.operationId, onProgress);
		}
		const operationId = request.operationId;
		if (this.transactions.has(operationId)) throw new Error(`Skill installation ${operationId} is already active`);
		const settings = this.captureSettings();
		const externalPaths = [...this.externalPaths];
		const normalized = normalizeSource(source);
		const kind = source.kind === "npm" ? "npm" : "git";
		const targetRoot = this.managedRoot(scope, kind, this.cwd, this.agentDir);
		const stagingBoundary = join(dirname(targetRoot), ".skill-staging");
		const stagingParent = join(stagingBoundary, randomUUID());
		const stagingAgentDir = join(stagingParent, "agent");
		const stagingCwd = scope === "project" ? join(stagingParent, "project-cwd") : this.cwd;
		let transaction: SkillInstallTransaction | undefined;
		try {
			onProgress?.("download", normalized);
			await mkdir(stagingAgentDir, { recursive: true, mode: 0o700 });
			const stagingRoot = this.managedRoot(scope, kind, stagingCwd, stagingAgentDir);
			await this.copyRootToStaging(targetRoot, stagingRoot);
			const stagingSettings = SettingsManager.inMemory(this.settings.getGlobalSettings(), {
				projectTrusted: this.projectTrusted,
			});
			const stagingManager = new DefaultPackageManager({
				cwd: stagingCwd,
				agentDir: stagingAgentDir,
				settingsManager: stagingSettings,
			});
			await stagingManager.install(normalized, { local: scope === "project" });
			const stagedPath = stagingManager.getInstalledPath(normalized, scope === "project" ? "project" : "user");
			if (!stagedPath) throw new Error("Pi package manager did not report a staged installed path");
			assertPathWithin(stagingRoot, stagedPath, "Staged package path");
			onProgress?.("validate");
			const skill = this.findPackageSkill(stagedPath, normalized);
			const diagnostics = loadedSkillDiagnostics(skill);
			if (diagnostics.length) throw new Error(diagnostics.join("; "));
			if (!skill) throw new Error("Installed package contains no valid SKILL.md");
			await this.assertNoDuplicate(skill.name, source);
			const managedRoot = await this.swapRoot(stagingRoot, targetRoot);
			transaction = { operationId, settings, externalPaths, stagingParent, stagingBoundary, managedRoot };
			this.transactions.set(operationId, transaction);
			await this.applyPackageSettings(normalized, scope);
			onProgress?.("commit");
			const installedPath = this.rebasePath(stagedPath, stagingRoot, targetRoot);
			return snapshotFromSkill(
				source,
				scope,
				skillFromDirectory(this.rebasePath(skill.baseDir, stagingRoot, targetRoot), normalized) ?? skill,
				installedPath,
				(await installedVersion(installedPath)) ?? source.version ?? source.ref ?? null,
				"installed",
			);
		} catch (error) {
			if (transaction) await this.restoreTransaction(transaction);
			else await rm(stagingParent, { recursive: true, force: true });
			throw error;
		}
	}

	private async importLocal(
		source: SkillSource,
		scope: SkillInstallScope,
		localPath: string,
		operationId: string,
		onProgress?: (phase: SkillInstallPhase, message?: string) => void,
	): Promise<SkillInstallationSnapshot> {
		const input = resolve(localPath);
		const info = await this.inspect({ source, scope, localPath: input });
		if (info.diagnostics.length || !info.name)
			throw new Error(info.diagnostics.join("; ") || "Skill name is missing");
		await this.assertNoDuplicate(info.name, source);
		onProgress?.("copy");
		const scopeRoot = scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
		const skillRoot = join(scopeRoot, "skills");
		const targetRoot = resolve(skillRoot, info.name);
		assertPathWithin(skillRoot, targetRoot, "Skill target path");
		const stagingBoundary = join(dirname(targetRoot), ".skill-staging");
		const staging = join(stagingBoundary, randomUUID());
		await mkdir(stagingBoundary, { recursive: true, mode: 0o700 });
		await rm(staging, { recursive: true, force: true });
		await cp(input, staging, { recursive: true, force: true });
		const stagedSkill = skillFromDirectory(staging, source.spec);
		const diagnostics = loadedSkillDiagnostics(stagedSkill);
		if (diagnostics.length) {
			await rm(staging, { recursive: true, force: true });
			throw new Error(diagnostics.join("; "));
		}
		const settings = this.captureSettings();
		const externalPaths = [...this.externalPaths];
		const localRoot = await this.swapRoot(staging, targetRoot);
		const transaction: SkillInstallTransaction = {
			operationId,
			settings,
			externalPaths,
			stagingParent: staging,
			stagingBoundary,
			localRoot,
		};
		this.transactions.set(operationId, transaction);
		try {
			this.addSkillPath(scope, targetRoot);
			await this.settings.flush();
			onProgress?.("validate");
			const skill = skillFromDirectory(targetRoot, source.spec);
			const targetDiagnostics = loadedSkillDiagnostics(skill);
			if (targetDiagnostics.length || !skill) throw new Error(targetDiagnostics.join("; "));
			return snapshotFromSkill(source, scope, skill, targetRoot, null, "installed");
		} catch (error) {
			await this.restoreTransaction(transaction);
			throw error;
		}
	}

	private async importExternal(
		source: SkillSource,
		scope: SkillInstallScope,
		localPath: string,
		operationId: string,
		onProgress?: (phase: SkillInstallPhase, message?: string) => void,
	): Promise<SkillInstallationSnapshot> {
		const path = resolve(localPath);
		const inspection = await this.inspect({ source, scope, localPath: path });
		if (inspection.diagnostics.length || !inspection.name)
			throw new Error(inspection.diagnostics.join("; ") || "Skill name is missing");
		await this.assertNoDuplicate(inspection.name, source);
		const transaction: SkillInstallTransaction = {
			operationId,
			settings: this.captureSettings(),
			externalPaths: [...this.externalPaths],
		};
		this.transactions.set(operationId, transaction);
		try {
			this.externalPaths = [...new Set([...this.externalPaths, path])];
			this.addSkillPath(scope, path);
			await this.settings.flush();
			onProgress?.("commit");
			return snapshotFromSkill(source, scope, skillFromDirectory(path, source.spec), path, null);
		} catch (error) {
			await this.restoreTransaction(transaction);
			throw error;
		}
	}

	private captureSettings(): SettingsSnapshot {
		const global = this.settings.getGlobalSettings();
		const project = this.settings.getProjectSettings();
		return {
			globalPackages: [...(global.packages ?? [])],
			projectPackages: [...(project.packages ?? [])],
			globalSkillPaths: [...(global.skills ?? [])],
			projectSkillPaths: [...(project.skills ?? [])],
			globalNpmCommand: global.npmCommand ? [...global.npmCommand] : undefined,
		};
	}

	private addSkillPath(scope: SkillInstallScope, path: string): void {
		if (scope === "project") {
			const paths = this.settings.getProjectSettings().skills ?? [];
			this.settings.setProjectSkillPaths([...new Set([...paths, path])]);
			return;
		}
		const paths = this.settings.getGlobalSettings().skills ?? [];
		this.settings.setSkillPaths([...new Set([...paths, path])]);
	}

	private enqueueTransaction<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.transactionQueue.then(operation, operation);
		this.transactionQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async restoreSettings(snapshot: SettingsSnapshot): Promise<void> {
		this.settings.setPackages([...snapshot.globalPackages]);
		this.settings.setProjectPackages([...snapshot.projectPackages]);
		this.settings.setSkillPaths([...snapshot.globalSkillPaths]);
		this.settings.setProjectSkillPaths([...snapshot.projectSkillPaths]);
		this.settings.setNpmCommand(snapshot.globalNpmCommand ? [...snapshot.globalNpmCommand] : undefined);
		await this.settings.flush();
	}

	private managedRoot(scope: SkillInstallScope, kind: "npm" | "git", cwd: string, agentDir: string): string {
		return scope === "project" ? join(cwd, CONFIG_DIR_NAME, kind) : join(agentDir, kind);
	}

	private skillRoot(scope: SkillInstallScope): string {
		return join(scope === "project" ? this.cwd : this.agentDir, scope === "project" ? CONFIG_DIR_NAME : "", "skills");
	}

	private async copyRootToStaging(targetRoot: string, stagingRoot: string): Promise<void> {
		assertPathWithin(dirname(stagingRoot), stagingRoot, "Staging root");
		await rm(stagingRoot, { recursive: true, force: true });
		try {
			await cp(targetRoot, stagingRoot, { recursive: true, force: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
		}
	}

	private async swapRoot(stagingRoot: string, targetRoot: string): Promise<ManagedRootTransaction> {
		assertPathWithin(dirname(stagingRoot), stagingRoot, "Staging root");
		const backupRoot = `${targetRoot}.backup-${randomUUID()}`;
		let hadTarget = true;
		try {
			await rename(targetRoot, backupRoot);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") hadTarget = false;
			else throw error;
		}
		try {
			await mkdir(dirname(targetRoot), { recursive: true, mode: 0o700 });
			await rename(stagingRoot, targetRoot);
		} catch (error) {
			if (hadTarget) await rename(backupRoot, targetRoot).catch(() => undefined);
			throw error;
		}
		return { targetRoot, stagingRoot, backupRoot, hadTarget };
	}

	private async detachRoot(targetRoot: string): Promise<ManagedRootTransaction> {
		assertPathWithin(dirname(targetRoot), targetRoot, "Managed target path");
		const backupRoot = `${targetRoot}.backup-${randomUUID()}`;
		try {
			await rename(targetRoot, backupRoot);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new Error(`Managed Skill path does not exist: ${targetRoot}`);
			throw error;
		}
		return { targetRoot, stagingRoot: targetRoot, backupRoot, hadTarget: true };
	}

	private rebasePath(path: string, fromRoot: string, toRoot: string): string {
		assertPathWithin(fromRoot, path, "Staged resource path");
		return resolve(toRoot, relative(resolve(fromRoot), resolve(path)));
	}

	private findPackageSkill(packagePath: string, source: string): Skill | undefined {
		return skillFromDirectory(join(packagePath, "skills"), source) ?? skillFromDirectory(packagePath, source);
	}

	private async assertNoDuplicate(name: string, source: SkillSource): Promise<void> {
		const existing = await this.list();
		const duplicate = existing.find((item) => item.name === name && sourceKey(item.source) !== sourceKey(source));
		if (duplicate) throw new Error(`Skill name ${name} is already installed from ${duplicate.source.spec}`);
	}

	private async applyPackageSettings(source: string, scope: SkillInstallScope): Promise<void> {
		const packageSource: PackageSource = {
			source,
			autoload: false,
			skills: ["**"],
			extensions: [],
			prompts: [],
			themes: [],
		};
		if (scope === "project") {
			const packages = (this.settings.getProjectSettings().packages ?? []).filter(
				(item) => (typeof item === "string" ? item : item.source) !== source,
			);
			this.settings.setProjectPackages([...packages, packageSource]);
		} else {
			const packages = (this.settings.getGlobalSettings().packages ?? []).filter(
				(item) => (typeof item === "string" ? item : item.source) !== source,
			);
			this.settings.setPackages([...packages, packageSource]);
		}
		await this.settings.flush();
	}

	private removePackageFromSettings(source: string, scope: SkillInstallScope): void {
		if (scope === "project") {
			this.settings.setProjectPackages(
				(this.settings.getProjectSettings().packages ?? []).filter(
					(item) => (typeof item === "string" ? item : item.source) !== source,
				),
			);
			return;
		}
		this.settings.setPackages(
			this.settings.getPackages().filter((item) => (typeof item === "string" ? item : item.source) !== source),
		);
	}

	private removeSkillPathFromSettings(path: string, scope: SkillInstallScope): void {
		if (scope === "project") {
			this.settings.setProjectSkillPaths(
				(this.settings.getProjectSettings().skills ?? []).filter((item) => resolve(item) !== resolve(path)),
			);
			return;
		}
		this.settings.setSkillPaths(this.settings.getSkillPaths().filter((item) => resolve(item) !== resolve(path)));
	}

	async commit(operationId: string): Promise<void> {
		const transaction = this.transactions.get(operationId);
		if (!transaction) return;
		try {
			if (transaction.managedRoot) await rm(transaction.managedRoot.backupRoot, { recursive: true, force: true });
			if (transaction.localRoot) await rm(transaction.localRoot.backupRoot, { recursive: true, force: true });
			await this.cleanupStaging(transaction);
		} finally {
			// Cleanup can be retried by the filesystem later, but must not block later operations.
			this.transactions.delete(operationId);
		}
	}

	async rollback(operationId: string): Promise<void> {
		const transaction = this.transactions.get(operationId);
		if (!transaction) return;
		try {
			if (transaction.managedRoot) await this.restoreRoot(transaction.managedRoot);
			if (transaction.localRoot) await this.restoreRoot(transaction.localRoot);
			this.externalPaths = [...transaction.externalPaths];
			await this.restoreSettings(transaction.settings);
		} finally {
			await this.cleanupStaging(transaction);
			this.transactions.delete(operationId);
		}
	}

	private async restoreTransaction(transaction: SkillInstallTransaction): Promise<void> {
		if (!this.transactions.has(transaction.operationId)) this.transactions.set(transaction.operationId, transaction);
		await this.rollback(transaction.operationId);
	}

	private async restoreRoot(transaction: ManagedRootTransaction): Promise<void> {
		assertPathWithin(dirname(transaction.targetRoot), transaction.targetRoot, "Managed target path");
		await rm(transaction.targetRoot, { recursive: true, force: true });
		if (transaction.hadTarget) await rename(transaction.backupRoot, transaction.targetRoot);
	}

	private async cleanupStaging(transaction: SkillInstallTransaction): Promise<void> {
		if (!transaction.stagingParent || !transaction.stagingBoundary) return;
		assertPathWithin(transaction.stagingBoundary, transaction.stagingParent, "Staging transaction path");
		await rm(transaction.stagingParent, { recursive: true, force: true });
	}

	prepareRemove(
		installation: SkillInstallationSnapshot,
		operationId: string,
		onProgress?: (phase: SkillInstallPhase, message?: string) => void,
	): Promise<void> {
		return this.enqueueTransaction(() => this.prepareRemoveInternal(installation, operationId, onProgress));
	}

	private async prepareRemoveInternal(
		installation: SkillInstallationSnapshot,
		operationId: string,
		onProgress?: (phase: SkillInstallPhase, message?: string) => void,
	): Promise<void> {
		if (installation.scope === "project" && !this.projectTrusted)
			throw new Error("Project must be trusted before removing a Skill");
		if ((installation.source.kind === "npm" || installation.source.kind === "git") && !this.npmCommand)
			throw new Error("Managed Skill removal requires a configured Node/npm sidecar");
		if (this.transactions.size > 0) throw new Error("Another Skill installation is awaiting runtime validation");
		const settings = this.captureSettings();
		const externalPaths = [...this.externalPaths];
		let transaction: SkillInstallTransaction | undefined;
		try {
			onProgress?.("commit");
			if (installation.source.kind === "npm" || installation.source.kind === "git") {
				const source = normalizeSource(installation.source);
				const kind = installation.source.kind;
				const targetRoot = this.managedRoot(installation.scope, kind, this.cwd, this.agentDir);
				const stagingBoundary = join(dirname(targetRoot), ".skill-staging");
				const stagingParent = join(stagingBoundary, randomUUID());
				const stagingAgentDir = join(stagingParent, "agent");
				const stagingCwd = installation.scope === "project" ? join(stagingParent, "project-cwd") : this.cwd;
				await mkdir(stagingAgentDir, { recursive: true, mode: 0o700 });
				const stagingRoot = this.managedRoot(installation.scope, kind, stagingCwd, stagingAgentDir);
				await this.copyRootToStaging(targetRoot, stagingRoot);
				const stagingSettings = SettingsManager.inMemory(this.settings.getGlobalSettings(), {
					projectTrusted: this.projectTrusted,
				});
				const stagingManager = new DefaultPackageManager({
					cwd: stagingCwd,
					agentDir: stagingAgentDir,
					settingsManager: stagingSettings,
				});
				await stagingManager.remove(source, { local: installation.scope === "project" });
				const managedRoot = await this.swapRoot(stagingRoot, targetRoot);
				transaction = { operationId, settings, externalPaths, stagingParent, stagingBoundary, managedRoot };
				this.transactions.set(operationId, transaction);
				this.removePackageFromSettings(source, installation.scope);
				await this.settings.flush();
				return;
			}
			if (
				installation.path &&
				isAbsolute(installation.path) &&
				isPathWithin(this.skillRoot(installation.scope), installation.path)
			) {
				const localRoot = await this.detachRoot(installation.path);
				transaction = { operationId, settings, externalPaths, localRoot };
				this.transactions.set(operationId, transaction);
				this.removeSkillPathFromSettings(installation.path, installation.scope);
				await this.settings.flush();
				return;
			}
			if (installation.path && installation.source.kind === "external") {
				const removedPath = installation.path;
				transaction = { operationId, settings, externalPaths };
				this.transactions.set(operationId, transaction);
				if (installation.scope === "global") {
					this.externalPaths = this.externalPaths.filter((path) => resolve(path) !== resolve(removedPath));
				}
				this.removeSkillPathFromSettings(removedPath, installation.scope);
				await this.settings.flush();
				return;
			}
			throw new Error("Skill installation has no removable managed path");
		} catch (error) {
			if (transaction) await this.restoreTransaction(transaction);
			throw error;
		}
	}

	async remove(
		installation: SkillInstallationSnapshot,
		onProgress?: (phase: SkillInstallPhase, message?: string) => void,
	): Promise<void> {
		const operationId = `remove-${randomUUID()}`;
		await this.prepareRemove(installation, operationId, onProgress);
		await this.commit(operationId).catch(() => undefined);
	}

	async list(scope?: SkillInstallScope): Promise<SkillInstallationSnapshot[]> {
		const result: SkillInstallationSnapshot[] = [];
		for (const item of this.manager.listConfiguredPackages()) {
			const itemScope = item.scope === "project" ? "project" : "global";
			if (scope && itemScope !== scope) continue;
			const path =
				item.installedPath ??
				this.manager.getInstalledPath(item.source, itemScope === "project" ? "project" : "user");
			const skill = path
				? (skillFromDirectory(join(path, "skills"), item.source) ?? skillFromDirectory(path, item.source))
				: undefined;
			result.push(
				snapshotFromSkill(
					{ kind: item.source.startsWith("npm:") ? "npm" : "git", spec: item.source, version: null, ref: null },
					itemScope,
					skill,
					path ?? null,
					path ? await installedVersion(path) : null,
					skill ? "installed" : "warning",
					skill ? [] : ["Package has no valid Skill"],
				),
			);
		}
		const configuredPaths = new Map<string, { path: string; scope: SkillInstallScope }>();
		const addPaths = (paths: readonly string[], itemScope: SkillInstallScope) => {
			if (scope && itemScope !== scope) return;
			for (const path of paths) {
				const resolvedPath = resolve(path);
				configuredPaths.set(`${itemScope}:${resolvedPath}`, { path: resolvedPath, scope: itemScope });
			}
		};
		addPaths(this.externalPaths, "global");
		addPaths(this.settings.getSkillPaths(), "global");
		addPaths(this.settings.getProjectSettings().skills ?? [], "project");
		for (const { path, scope: itemScope } of configuredPaths.values()) {
			const skill = skillFromDirectory(path, path);
			if (!skill) continue;
			const kind = isPathWithin(this.skillRoot(itemScope), path) ? "local" : "external";
			result.push(snapshotFromSkill({ kind, spec: path }, itemScope, skill, path, null, "installed"));
		}
		return result;
	}

	async reconcile(): Promise<SkillInstallationSnapshot[]> {
		const items = await this.list();
		return items.map((item) => ({ ...item, updatedAt: new Date().toISOString() }));
	}

	async runtimePaths(): Promise<string[]> {
		const items = await this.list();
		return items.filter((item) => item.path && item.status !== "error").map((item) => item.path as string);
	}
}
