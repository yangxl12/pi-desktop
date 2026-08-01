import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SingleInstancePort } from "@earendil-works/pi-desktop-core";

export class FileSingleInstancePort implements SingleInstancePort {
	private readonly lockPath: string;
	private handle: FileHandle | undefined;

	constructor(dataDirectory: string) {
		this.lockPath = join(dataDirectory, "desktop.lock");
	}

	async acquire(_onSecondInstance: () => void): Promise<boolean> {
		await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
		try {
			this.handle = await open(this.lockPath, "wx", 0o600);
			await this.handle.writeFile(String(process.pid), "utf8");
			return true;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const pid = Number(await readFile(this.lockPath, "utf8"));
				process.kill(pid, 0);
				return false;
			} catch {
				await unlink(this.lockPath).catch(() => undefined);
				this.handle = await open(this.lockPath, "wx", 0o600);
				await this.handle.writeFile(String(process.pid), "utf8");
				return true;
			}
		}
	}

	async release(): Promise<void> {
		await this.handle?.close();
		this.handle = undefined;
		await unlink(this.lockPath).catch(() => undefined);
	}
}
