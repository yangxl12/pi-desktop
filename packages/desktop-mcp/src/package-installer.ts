import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpServerProfile } from "@earendil-works/pi-desktop-protocol";

const execFileAsync = promisify(execFile);

export interface ManagedMcpPackageSpec {
	packageSpec: string;
	version: string | null;
	args: string[];
}

export interface ParsedNpmPackageSpec {
	name: string;
	version: string | null;
}

export function parseNpmPackageSpec(packageSpec: string): ParsedNpmPackageSpec {
	const value = packageSpec.trim();
	if (!value || value.startsWith(".") || value.includes("\\") || value.includes(":"))
		throw new Error(`Unsupported managed npm package spec: ${packageSpec}`);
	const versionAt = value.lastIndexOf("@");
	const scoped = value.startsWith("@");
	const hasVersion = scoped ? versionAt > value.indexOf("/") : versionAt > 0;
	const name = hasVersion ? value.slice(0, versionAt) : value;
	const version = hasVersion ? value.slice(versionAt + 1) : null;
	if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) || (hasVersion && !version))
		throw new Error(`Invalid managed npm package spec: ${packageSpec}`);
	return { name, version };
}

export function parseNpxCommand(command: string | null, args: readonly string[]): ManagedMcpPackageSpec | null {
	if (command?.toLowerCase() !== "npx" && command?.toLowerCase() !== "npx.cmd") return null;
	const values = [...args];
	while (values[0]?.startsWith("-")) {
		const option = values.shift();
		if ((option === "--package" || option === "-p") && values.length > 0) values.shift();
	}
	const packageSpec = values.shift();
	if (!packageSpec) return null;
	const { version } = parseNpmPackageSpec(packageSpec);
	return { packageSpec, version, args: values };
}

export class McpPackageInstaller {
	private readonly options: { sidecarPath: string; npmCliPath: string; installRoot: string };
	constructor(options: { sidecarPath: string; npmCliPath: string; installRoot: string }) {
		this.options = options;
	}

	async install(
		profile: McpServerProfile,
	): Promise<{ command: string; args: string[]; packageVersion: string | null }> {
		const parsed = parseNpxCommand(profile.command, profile.args);
		const packageSpec = profile.packageSpec ?? parsed?.packageSpec;
		if (!packageSpec) throw new Error("Managed MCP profile requires packageSpec");
		const packageIdentity = parseNpmPackageSpec(packageSpec);
		const requestedVersion = profile.packageVersion ?? packageIdentity.version;
		const installSpec = requestedVersion ? `${packageIdentity.name}@${requestedVersion}` : packageSpec;
		const staging = join(this.options.installRoot, `.staging-${profile.id}`);
		const target = join(this.options.installRoot, profile.id);
		const backup = join(this.options.installRoot, `.backup-${profile.id}`);
		const launchArgs = parsed?.args ?? [...profile.args];
		const cached = await this.resolveInstalled(target, packageIdentity.name, profile.bin, launchArgs).catch(
			() => null,
		);
		if (cached && (!requestedVersion || cached.packageVersion === requestedVersion)) return cached;
		await rm(staging, { recursive: true, force: true });
		await rm(backup, { recursive: true, force: true });
		await mkdir(staging, { recursive: true, mode: 0o700 });
		try {
			await execFileAsync(
				this.options.sidecarPath,
				[
					this.options.npmCliPath,
					"install",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
					"--save-exact",
					"--prefix",
					staging,
					installSpec,
				],
				{ windowsHide: true, timeout: profile.timeoutMs, cwd: staging },
			);
			await this.resolveInstalled(staging, packageIdentity.name, profile.bin, launchArgs);
			let hadTarget = true;
			try {
				await rename(target, backup);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") hadTarget = false;
				else throw error;
			}
			try {
				await rename(staging, target);
			} catch (error) {
				if (hadTarget) await rename(backup, target);
				throw error;
			}
			await rm(backup, { recursive: true, force: true });
			return await this.resolveInstalled(target, packageIdentity.name, profile.bin, launchArgs);
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
	}

	async remove(serverId: string): Promise<void> {
		await rm(join(this.options.installRoot, serverId), { recursive: true, force: true });
		await rm(join(this.options.installRoot, `.staging-${serverId}`), { recursive: true, force: true });
		await rm(join(this.options.installRoot, `.backup-${serverId}`), { recursive: true, force: true });
	}

	private async resolveInstalled(
		root: string,
		packageName: string,
		requestedBin: string | null | undefined,
		launchArgs: string[],
	): Promise<{ command: string; args: string[]; packageVersion: string | null }> {
		const packageDirectory = join(root, "node_modules", ...packageName.split("/"));
		const packageJson = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as {
			bin?: string | Record<string, string>;
			version?: string;
		};
		const binName =
			requestedBin ??
			(typeof packageJson.bin === "string" ? packageName.split("/").pop() : Object.keys(packageJson.bin ?? {})[0]);
		if (!binName) throw new Error("Managed MCP package has no executable bin");
		const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.[binName];
		if (!bin) throw new Error(`Managed MCP bin not found: ${binName}`);
		const entry = resolve(packageDirectory, bin);
		if (relative(packageDirectory, entry).startsWith("..") || dirname(entry) === entry)
			throw new Error(`Managed MCP bin escapes package directory: ${binName}`);
		await access(entry);
		const serverArgs = launchArgs[0] && resolve(launchArgs[0]) === entry ? launchArgs.slice(1) : launchArgs;
		return {
			command: this.options.sidecarPath,
			args: [entry, ...serverArgs],
			packageVersion: packageJson.version ?? null,
		};
	}
}
