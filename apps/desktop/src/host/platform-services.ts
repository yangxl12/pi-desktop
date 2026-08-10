import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FolderPickerPort, ModelConnectionTester, SecretStore } from "@earendil-works/pi-desktop-core";
import type { ModelProfile } from "@earendil-works/pi-desktop-protocol";

interface ProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runProcess(command: string, args: string[], input?: string): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.once("error", reject);
		child.once("exit", (code) =>
			resolve({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			}),
		);
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

function assertProcess(result: ProcessResult, operation: string): string {
	if (result.code === 0) return result.stdout.trim();
	throw new Error(`${operation} failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
}

export class PlatformSecretStore implements SecretStore {
	private readonly dataPath: string;
	private readonly platform: NodeJS.Platform;
	private readonly service = "Pi Desktop";

	constructor(dataDirectory: string, platform = process.platform) {
		this.dataPath = join(dataDirectory, "secrets.json");
		this.platform = platform;
	}

	async set(value: string, ref = `secret_${randomUUID()}`): Promise<string> {
		if (this.platform === "darwin") {
			assertProcess(
				await runProcess("security", ["add-generic-password", "-a", ref, "-s", this.service, "-U", "-w", value]),
				"macOS Keychain write",
			);
			return ref;
		}
		if (this.platform !== "win32") throw new Error("OS credential storage is unavailable on this platform");
		const encrypted = await this.protectWindows(value);
		const values = await this.readWindowsValues();
		values[ref] = encrypted;
		await this.writeWindowsValues(values);
		return ref;
	}

	async get(ref: string): Promise<string | null> {
		if (this.platform === "darwin") {
			try {
				return assertProcess(
					await runProcess("security", ["find-generic-password", "-a", ref, "-s", this.service, "-w"]),
					"macOS Keychain read",
				);
			} catch {
				return null;
			}
		}
		if (this.platform !== "win32") return null;
		const values = await this.readWindowsValues();
		const encrypted = values[ref];
		return encrypted ? this.unprotectWindows(encrypted) : null;
	}

	async delete(ref: string): Promise<void> {
		if (this.platform === "darwin") {
			await runProcess("security", ["delete-generic-password", "-a", ref, "-s", this.service]);
			return;
		}
		if (this.platform !== "win32") return;
		const values = await this.readWindowsValues();
		delete values[ref];
		await this.writeWindowsValues(values);
	}

	private async protectWindows(value: string): Promise<string> {
		const script =
			"Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
		return assertProcess(
			await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], value),
			"Windows credential encryption",
		);
	}

	private async unprotectWindows(value: string): Promise<string | null> {
		const script =
			"Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
		try {
			return assertProcess(
				await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], value),
				"Windows credential decryption",
			);
		} catch {
			return null;
		}
	}

	private async readWindowsValues(): Promise<Record<string, string>> {
		try {
			return JSON.parse(await readFile(this.dataPath, "utf8")) as Record<string, string>;
		} catch {
			return {};
		}
	}

	private async writeWindowsValues(values: Record<string, string>): Promise<void> {
		await mkdir(dirname(this.dataPath), { recursive: true, mode: 0o700 });
		await writeFile(this.dataPath, JSON.stringify(values), { encoding: "utf8", mode: 0o600 });
		await chmod(this.dataPath, 0o600);
	}
}

export class NativeFolderPickerPort implements FolderPickerPort {
	private readonly platform: NodeJS.Platform;

	constructor(platform = process.platform) {
		this.platform = platform;
	}

	async selectProjectFolder(): Promise<string | null> {
		if (this.platform === "win32") {
			const script =
				"$shell=New-Object -ComObject Shell.Application; $folder=$shell.BrowseForFolder(0,'Select project folder',0,0); if ($folder) { $folder.Self.Path }";
			try {
				const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
				return result.code === 0 ? result.stdout.trim() || null : null;
			} catch {
				return null;
			}
		}
		if (this.platform === "darwin") {
			try {
				const result = await runProcess("osascript", [
					"-e",
					'POSIX path of (choose folder with prompt "Select project folder")',
				]);
				return result.code === 0 ? result.stdout.trim() || null : null;
			} catch {
				return null;
			}
		}
		return null;
	}
}

export class FetchModelConnectionTester implements ModelConnectionTester {
	async test(
		profile: ModelProfile,
		apiKey: string | null,
	): Promise<{ ok: boolean; status: number | null; latencyMs: number; message: string }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10_000);
		const startedAt = Date.now();
		try {
			const endpoint = `${profile.baseUrl.replace(/\/+$/, "")}/models`;
			const response = await fetch(endpoint, {
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
				signal: controller.signal,
			});
			return {
				ok: response.ok,
				status: response.status,
				latencyMs: Date.now() - startedAt,
				message: response.ok ? "Connection successful" : `Endpoint returned HTTP ${response.status}`,
			};
		} catch (error: unknown) {
			return {
				ok: false,
				status: null,
				latencyMs: Date.now() - startedAt,
				message:
					error instanceof Error && error.name === "AbortError"
						? "Connection timed out"
						: error instanceof Error
							? error.message
							: String(error),
			};
		} finally {
			clearTimeout(timeout);
		}
	}
}
