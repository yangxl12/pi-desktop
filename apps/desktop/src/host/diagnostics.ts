import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Diagnostic } from "@earendil-works/pi-desktop-protocol";

const SECRET_PATTERN = /(authorization|api[_-]?key|token|secret|password)(["'=:\s]+)([^\s,"'}]+)/gi;

export function redactDiagnosticText(value: string): string {
	return value.replace(SECRET_PATTERN, "$1$2[REDACTED]");
}

export async function exportDiagnostics(
	directory: string,
	diagnostics: readonly Diagnostic[],
	metadata: Record<string, string>,
): Promise<string> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `pi-desktop-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	await writeFile(
		path,
		JSON.stringify(
			{
				metadata,
				diagnostics: diagnostics.map((item) => ({ ...item, message: redactDiagnosticText(item.message) })),
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	return path;
}

export async function rotateLogs(directory: string, maxFiles = 10, maxAgeDays = 14): Promise<void> {
	let files: string[];
	try {
		files = await readdir(directory);
	} catch {
		return;
	}
	const candidates = await Promise.all(
		files
			.filter((file) => file.endsWith(".log") || file.endsWith(".json"))
			.map(async (file) => ({
				path: join(directory, file),
				name: basename(file),
				modified: (await stat(join(directory, file))).mtimeMs,
			})),
	);
	const cutoff = Date.now() - maxAgeDays * 86_400_000;
	for (const candidate of candidates.sort((a, b) => b.modified - a.modified).slice(maxFiles)) {
		await unlink(candidate.path).catch(() => undefined);
	}
	for (const candidate of candidates.filter((item) => item.modified < cutoff)) {
		await unlink(candidate.path).catch(() => undefined);
	}
}
