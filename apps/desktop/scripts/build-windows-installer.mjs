import { build } from "esbuild";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve("../..");
const appDirectory = resolve(".");
const piRpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const piPackageDirectory = resolve(dirname(piRpcEntry), "..");
const manifest = JSON.parse(await readFile(join(appDirectory, "package.json"), "utf8"));
const workDirectory = resolve("../../.pi-dev/electron-build");
const appResources = join(workDirectory, "resources", "app");
const outputDirectory = resolve("../../.pi-dev/win11-installer");
if (!workDirectory.startsWith(root) || !outputDirectory.startsWith(root)) throw new Error("Packaging paths must stay inside the workspace");
await rm(workDirectory, { recursive: true, force: true });
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(join(appResources, "renderer"), { recursive: true });
await mkdir(join(appResources, "extensions"), { recursive: true });

const common = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "warning",
	banner: { js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);' },
	treeShaking: false,
};
await build({ ...common, entryPoints: [join(root, "apps/desktop/src/electron/main.ts")], outfile: join(workDirectory, "main.mjs"), external: ["electron"] });
await build({ ...common, entryPoints: [join(root, "apps/desktop/src/host/main.ts")], outfile: join(appResources, "host.mjs") });
await build({ ...common, entryPoints: [piRpcEntry], outfile: join(appResources, "rpc-entry.mjs") });
await build({ ...common, entryPoints: [join(appDirectory, "src", "extensions", "web-search.ts")], outfile: join(appResources, "extensions", "web-search.mjs") });
const themeDirectory = join(appResources, "dist", "modes", "interactive", "theme");
await cp(join(piPackageDirectory, "dist", "modes", "interactive", "theme"), themeDirectory, { recursive: true });
for (const theme of ["dark.json", "light.json"]) await access(join(themeDirectory, theme));
await cp(join(appDirectory, "src", "renderer"), join(appResources, "renderer"), { recursive: true });
await cp(join(root, "node_modules", "lucide", "dist", "esm"), join(appResources, "lucide"), { recursive: true });
await cp(
	join(piPackageDirectory, "node_modules", "@earendil-works"),
	join(appResources, "node_modules", "@earendil-works"),
	{ recursive: true },
);
await cp(join(piPackageDirectory, "node_modules", "typebox"), join(appResources, "node_modules", "typebox"), {
	recursive: true,
});
await writeFile(join(workDirectory, "package.json"), JSON.stringify({
	name: "pi-desktop",
	version: manifest.version,
	description: "Pi desktop AI agent",
	author: "Earendil Works",
	main: "main.mjs",
	type: "module",
}, null, 2));

const builderConfig = {
	appId: "works.earendil.pi.desktop",
	productName: "Pi Desktop",
	directories: { app: workDirectory, output: outputDirectory, buildResources: workDirectory },
	files: ["main.mjs", "package.json"],
	extraResources: [{ from: appResources, to: "app" }],
	electronVersion: "43.2.0",
	asar: true,
	win: { target: [{ target: "nsis", arch: ["x64"] }], artifactName: `Pi-Desktop-Setup-${manifest.version}-win11-x64.${"${ext}"}` },
	nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: "Pi Desktop", runAfterFinish: true, deleteAppDataOnUninstall: false },
};
await mkdir(workDirectory, { recursive: true });
const configPath = join(workDirectory, "electron-builder.json");
await writeFile(configPath, JSON.stringify(builderConfig, null, 2));
await execFileAsync(process.execPath, [join(root, "node_modules", "electron-builder", "cli.js"), "--config", configPath, "--win", "nsis", "--x64", "--publish", "never"], {
	cwd: appDirectory,
	windowsHide: true,
	maxBuffer: 50 * 1024 * 1024,
	env: {
		...process.env,
		CSC_IDENTITY_AUTO_DISCOVERY: "false",
		ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? "https://npmmirror.com/mirrors/electron/",
		ELECTRON_BUILDER_BINARIES_MIRROR: process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? "https://npmmirror.com/mirrors/electron-builder-binaries/",
	},
});
console.log(join(outputDirectory, `Pi-Desktop-Setup-${manifest.version}-win11-x64.exe`));
