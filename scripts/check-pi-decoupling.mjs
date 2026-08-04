import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dependencyName = "@earendil-works/pi-coding-agent";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siblingPiRoot = resolve(root, "..", "pi");
const errors = [];

function assert(condition, message) {
	if (!condition) errors.push(message);
}

function isInside(parent, candidate) {
	const path = relative(parent, candidate);
	return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

const bridgeManifest = await readJson(resolve(root, "packages", "desktop-pi-bridge", "package.json"));
const dependencyVersion = bridgeManifest.dependencies?.[dependencyName];
assert(
	typeof dependencyVersion === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dependencyVersion),
	`${dependencyName} must use an exact registry version, not a file, link, workspace, or range dependency`,
);

const lock = await readJson(resolve(root, "package-lock.json"));
const lockEntry = lock.packages?.[`node_modules/${dependencyName}`];
assert(lockEntry?.version === dependencyVersion, `${dependencyName} lockfile version must match the bridge manifest`);
assert(lockEntry?.link !== true, `${dependencyName} must not be linked from another checkout`);
assert(/^https:\/\//.test(lockEntry?.resolved ?? ""), `${dependencyName} must resolve from an HTTPS registry tarball`);
assert(/^sha512-/.test(lockEntry?.integrity ?? ""), `${dependencyName} must have a sha512 lockfile integrity value`);

const installedDirectory = resolve(root, "node_modules", ...dependencyName.split("/"));
try {
	const installedRealPath = await realpath(installedDirectory);
	const installedManifest = await readJson(resolve(installedRealPath, "package.json"));
	const rpcEntry = await realpath(fileURLToPath(import.meta.resolve(`${dependencyName}/rpc-entry`)));
	assert(isInside(root, installedRealPath), `${dependencyName} resolves outside the pi-desktop repository`);
	assert(
		installedManifest.version === dependencyVersion,
		`${dependencyName} installed version does not match the lockfile`,
	);
	assert(isInside(installedRealPath, rpcEntry), `${dependencyName}/rpc-entry resolves outside its installed package`);
} catch (error) {
	errors.push(`Unable to verify the installed ${dependencyName}: ${error.message}`);
}

const textExtensions = new Set([
	".cjs",
	".css",
	".html",
	".js",
	".json",
	".md",
	".mjs",
	".ps1",
	".sh",
	".ts",
	".tsx",
	".yaml",
	".yml",
]);
const ignoredDirectories = new Set([".git", ".pi-dev", "coverage", "dist", "node_modules"]);
const siblingReferences = [siblingPiRoot, siblingPiRoot.replaceAll("\\", "/"), pathToFileURL(siblingPiRoot).href].map(
	(value) => value.toLowerCase(),
);
const relativeSiblingPattern = /(?:^|["'`\s(=:])(?:\.\.[\\/])+pi(?:[\\/]|["'`\s),;]|$)/u;

async function scanDirectory(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) {
			await scanDirectory(path);
			continue;
		}
		if (!entry.isFile() || !textExtensions.has(extname(entry.name))) continue;
		const content = await readFile(path, "utf8");
		const lowerContent = content.toLowerCase();
		if (
			siblingReferences.some((reference) => lowerContent.includes(reference)) ||
			relativeSiblingPattern.test(content)
		) {
			errors.push(`${relative(root, path)} references the sibling Pi checkout`);
		}
	}
}

for (const directory of ["apps", "packages", "scripts"]) await scanDirectory(resolve(root, directory));

if (errors.length > 0) {
	for (const error of errors) console.error(`- ${error}`);
	process.exitCode = 1;
} else {
	console.log(`${dependencyName}@${dependencyVersion} is registry-pinned and contained within pi-desktop`);
}
