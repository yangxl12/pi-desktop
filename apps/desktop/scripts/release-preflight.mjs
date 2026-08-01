import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const failures = [];
const required = process.platform === "darwin"
	? ["APPLE_TEAM_ID", "APPLE_SIGNING_IDENTITY", "APPLE_NOTARY_PROFILE"]
	: process.platform === "win32" ? ["WINDOWS_CERTIFICATE_PATH"] : [];
for (const name of required) if (!process.env[name]) failures.push(`Missing ${name}`);
if (process.platform === "win32" && process.env.WINDOWS_CERTIFICATE_PATH) {
	try { await access(resolve(process.env.WINDOWS_CERTIFICATE_PATH)); } catch { failures.push("Windows signing certificate does not exist"); }
}
const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const expected = manifest.engines.node.replace(">=", "");
const [requiredMajor, requiredMinor, requiredPatch] = expected.split(".").map(Number);
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < requiredMajor || (major === requiredMajor && (minor < requiredMinor || (minor === requiredMinor && patch < requiredPatch)))) failures.push(`Node runtime must be >=${expected}; found ${process.version}`);
if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else console.log(`Release preflight passed for ${process.platform}/${process.arch}`);
