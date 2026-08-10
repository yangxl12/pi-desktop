import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const failures = [];
const required = process.platform === "darwin"
	? ["APPLE_TEAM_ID", "APPLE_SIGNING_IDENTITY", "APPLE_NOTARY_PROFILE"]
	: process.platform === "win32" && process.env.RELEASE_REQUIRE_SIGNING === "1" ? ["WINDOWS_CERTIFICATE_PATH"] : [];
for (const name of required) if (!process.env[name]) failures.push(`Missing ${name}`);
if (process.platform === "win32" && process.env.WINDOWS_CERTIFICATE_PATH) {
	try { await access(resolve(process.env.WINDOWS_CERTIFICATE_PATH)); } catch { failures.push("Windows signing certificate does not exist"); }
}
const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const releaseManifestPath = resolve("release-manifest.json");
const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
if (!releaseManifest.productName || !releaseManifest.sidecar?.runtime || !releaseManifest.upgrade?.rollbackOnStartupFailure)
	failures.push("release-manifest.json must declare product, sidecar, and startup rollback policy");
if (releaseManifest.sidecar?.version !== manifest.engines.node)
	failures.push(`Sidecar version ${releaseManifest.sidecar?.version ?? "missing"} does not match package Node engine ${manifest.engines.node}`);
for (const relativePath of [
	"src/electron/main.ts",
	"src/host/main.ts",
	"scripts/build-windows-installer.mjs",
	"scripts/package-sidecar.mjs",
	"../../packages/desktop-pi-bridge/src/tool-bridge-extension.ts",
]) {
	try { await access(join(dirname(releaseManifestPath), relativePath)); } catch { failures.push(`Missing release input: ${relativePath}`); }
}
const expected = manifest.engines.node.replace(">=", "");
const [requiredMajor, requiredMinor, requiredPatch] = expected.split(".").map(Number);
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < requiredMajor || (major === requiredMajor && (minor < requiredMinor || (minor === requiredMinor && patch < requiredPatch)))) failures.push(`Node runtime must be >=${expected}; found ${process.version}`);
if (failures.length === 0) {
	const temporary = await mkdtemp(join(tmpdir(), "pi-desktop-sidecar-preflight-"));
	try {
		const { stdout } = await execFileAsync(process.execPath, [resolve("scripts/package-sidecar.mjs"), temporary], {
			cwd: resolve("../.."),
			windowsHide: true,
			env: process.env,
		});
		const sidecarDirectory = stdout.trim().split(/\r?\n/).at(-1);
		if (!sidecarDirectory) throw new Error("Sidecar packager did not report an output directory");
		const runtime = JSON.parse(await readFile(join(sidecarDirectory, "runtime.json"), "utf8"));
		for (const relativePath of [runtime.executable, runtime.npmCli])
			await access(join(sidecarDirectory, ...String(relativePath).split("/")));
		await execFileAsync(join(sidecarDirectory, runtime.executable), [join(sidecarDirectory, ...runtime.npmCli.split("/")), "--version"], {
			cwd: temporary,
			windowsHide: true,
			env: { SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? temporary },
		});
	} catch (error) {
		failures.push(`Sidecar/npm validation failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	const signing = process.env.RELEASE_REQUIRE_SIGNING === "1" ? "signed" : "unsigned-allowed";
	console.log(`Release preflight passed for ${process.platform}/${process.arch} (${signing})`);
}
