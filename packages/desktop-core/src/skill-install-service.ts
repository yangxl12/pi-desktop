import { randomUUID } from "node:crypto";
import type {
	SkillInstallationSnapshot,
	SkillInstallProgress,
	SkillInstallScope,
	SkillSource,
} from "@earendil-works/pi-desktop-protocol";
import type { MetadataRepository, SkillPackageInstallRequest, SkillPackagePort } from "./ports.ts";

export interface SkillInstallServiceOptions {
	port: SkillPackagePort;
	metadata?: MetadataRepository;
	onProgress?: (progress: SkillInstallProgress) => void;
	onReload?: () => Promise<undefined | readonly { name: string; source: string }[]>;
}

/** Coordinates UI and Agent skill installation calls with one idempotent transaction. */
export class SkillInstallService {
	private readonly operations = new Map<string, Promise<SkillInstallationSnapshot>>();
	private readonly removeOperations = new Map<string, Promise<void>>();
	private readonly options: SkillInstallServiceOptions;

	constructor(options: SkillInstallServiceOptions) {
		this.options = options;
	}

	async list(scope?: SkillInstallScope): Promise<SkillInstallationSnapshot[]> {
		const items = await this.options.port.list(scope);
		return items.map((item) => ({ ...item, diagnostics: [...item.diagnostics], source: { ...item.source } }));
	}

	async reconcile(commands?: readonly { name: string; source: string }[]): Promise<SkillInstallationSnapshot[]> {
		const items = this.withRuntimeStatus(await this.options.port.reconcile(), commands);
		await this.persistAll(items);
		return items;
	}

	async inspect(source: SkillSource, scope: SkillInstallScope = "global") {
		return this.options.port.inspect({ source, scope });
	}

	async install(
		source: SkillSource,
		scope: SkillInstallScope = "global",
		operationId: string = randomUUID(),
		localPath?: string,
	): Promise<SkillInstallationSnapshot> {
		const existing = this.operations.get(operationId);
		if (existing) return existing;
		const request: SkillPackageInstallRequest = { source, scope, operationId, localPath };
		const operation = this.runInstall(request);
		this.operations.set(operationId, operation);
		try {
			return await operation;
		} finally {
			this.operations.delete(operationId);
		}
	}

	async remove(installation: SkillInstallationSnapshot, operationId: string = randomUUID()): Promise<void> {
		const existing = this.removeOperations.get(operationId);
		if (existing) return existing;
		const operation = this.runRemove(installation, operationId);
		this.removeOperations.set(operationId, operation);
		try {
			await operation;
		} finally {
			this.removeOperations.delete(operationId);
		}
	}

	private async runRemove(installation: SkillInstallationSnapshot, operationId: string): Promise<void> {
		this.emit({ operationId, phase: "inspect", status: "running", installation });
		const transactionalRemove = this.options.port.prepareRemove;
		let reloadAttempted = false;
		try {
			const onProgress = (phase: SkillInstallProgress["phase"], message?: string) =>
				this.emit({ operationId, phase, status: "running", message, installation });
			if (transactionalRemove) await this.options.port.prepareRemove!(installation, operationId, onProgress);
			else await this.options.port.remove(installation, onProgress);
			this.emit({ operationId, phase: "load", status: "running", installation });
			reloadAttempted = Boolean(this.options.onReload);
			const commands = await this.options.onReload?.();
			if (commands && installation.commandName && this.hasRuntimeCommand(installation, commands))
				throw new Error(`Pi runtime still exposes the removed Skill command ${installation.commandName}`);
			await this.options.metadata?.deleteSkillInstallation?.(installation.id);
			try {
				await this.options.port.commit?.(operationId);
			} catch {
				// The verified removal remains effective if stale backup cleanup fails.
			}
			this.emit({ operationId, phase: "commit", status: "completed", installation });
		} catch (error) {
			let rollbackError: unknown;
			if (transactionalRemove) {
				try {
					await this.options.port.rollback?.(operationId);
				} catch (rollbackFailure) {
					rollbackError = rollbackFailure;
				}
			}
			if (reloadAttempted) {
				try {
					await this.options.onReload?.();
				} catch (reloadFailure) {
					rollbackError ??= reloadFailure;
				}
			}
			if (rollbackError && error instanceof Error) {
				error.message = `${error.message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
			}
			this.emit({
				operationId,
				phase: "validate",
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
				installation,
			});
			throw error;
		}
	}

	private async runInstall(request: SkillPackageInstallRequest): Promise<SkillInstallationSnapshot> {
		this.emit({ operationId: request.operationId, phase: "inspect", status: "running" });
		let installation: SkillInstallationSnapshot | undefined;
		let reloadAttempted = false;
		try {
			const installed = await this.options.port.install(request, (phase, message) =>
				this.emit({ operationId: request.operationId, phase, status: "running", message }),
			);
			installation = installed;
			this.emit({ operationId: request.operationId, phase: "load", status: "running", installation: installed });
			reloadAttempted = Boolean(this.options.onReload);
			const reloadResult = await this.options.onReload?.();
			const commands = Array.isArray(reloadResult) ? reloadResult : undefined;
			const reconciled = this.withRuntimeStatus(await this.options.port.reconcile(), commands);
			const loaded = reconciled.find((item) => item.id === installed.id) ?? installed;
			if (commands && installed.commandName && !this.hasRuntimeCommand(installed, commands)) {
				throw new Error(`Pi runtime did not expose the Skill command ${installed.commandName}`);
			}
			await this.options.metadata?.saveSkillInstallation?.(loaded);
			try {
				await this.options.port.commit?.(request.operationId);
			} catch {
				// The verified installation remains usable if stale transaction backup cleanup fails.
			}
			this.emit({ operationId: request.operationId, phase: "load", status: "completed", installation: loaded });
			return loaded;
		} catch (error) {
			if (installation) {
				let rollbackError: unknown;
				try {
					await this.rollbackInstall(request, installation);
				} catch (rollbackFailure) {
					rollbackError = rollbackFailure;
				}
				if (reloadAttempted) {
					try {
						await this.options.onReload?.();
					} catch (reloadFailure) {
						rollbackError ??= reloadFailure;
					}
				}
				if (rollbackError && error instanceof Error) {
					error.message = `${error.message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
				}
			}
			this.emit({
				operationId: request.operationId,
				phase: "validate",
				status: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	private async rollbackInstall(
		request: SkillPackageInstallRequest,
		installation: SkillInstallationSnapshot,
	): Promise<void> {
		if (this.options.port.rollback) {
			await this.options.port.rollback(request.operationId);
			return;
		}
		// Keep compatibility with third-party ports that predate transaction hooks.
		await this.options.port.remove(installation);
	}

	private hasRuntimeCommand(
		installation: SkillInstallationSnapshot,
		commands: readonly { name: string; source: string }[],
	): boolean {
		if (!installation.commandName) return true;
		return commands.some(
			(command) =>
				command.source === "skill" &&
				(command.name === installation.commandName ||
					command.name === installation.name ||
					`skill:${command.name}` === installation.commandName),
		);
	}

	private async persistAll(items: readonly SkillInstallationSnapshot[]): Promise<void> {
		for (const item of items) await this.options.metadata?.saveSkillInstallation?.(item);
	}

	private withRuntimeStatus(
		items: readonly SkillInstallationSnapshot[],
		commands?: readonly { name: string; source: string }[],
	): SkillInstallationSnapshot[] {
		if (!commands) return items.map((item) => ({ ...item, diagnostics: [...item.diagnostics] }));
		return items.map((item) => {
			if (!item.commandName) return { ...item, diagnostics: [...item.diagnostics] };
			const loaded = commands.some(
				(command) =>
					command.source === "skill" &&
					(command.name === item.commandName ||
						command.name === item.name ||
						`skill:${command.name}` === item.commandName),
			);
			return {
				...item,
				status: loaded ? "loaded" : "warning",
				diagnostics: loaded
					? item.diagnostics.filter((diagnostic) => diagnostic !== "Pi runtime did not expose the Skill command")
					: [...new Set([...item.diagnostics, "Pi runtime did not expose the Skill command"])],
			};
		});
	}

	private emit(progress: SkillInstallProgress): void {
		this.options.onProgress?.(progress);
	}
}
