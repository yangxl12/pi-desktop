import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function backupDatabase(databasePath: string, backupDirectory: string, keep = 5): Promise<string> {
	await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
	const backupPath = join(
		backupDirectory,
		`${basename(databasePath)}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`,
	);
	await copyFile(databasePath, backupPath);
	const backups = await Promise.all(
		(await readdir(backupDirectory))
			.filter((file) => file.endsWith(".bak"))
			.map(async (file) => ({
				path: join(backupDirectory, file),
				modified: (await stat(join(backupDirectory, file))).mtimeMs,
			})),
	);
	for (const stale of backups.sort((a, b) => b.modified - a.modified).slice(keep)) await unlink(stale.path);
	return backupPath;
}

export async function backupBeforeMigration(databasePath: string): Promise<string | null> {
	try {
		await stat(databasePath);
	} catch {
		return null;
	}
	return backupDatabase(databasePath, join(dirname(databasePath), "backups"));
}
