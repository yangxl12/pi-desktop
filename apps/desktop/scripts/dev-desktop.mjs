import { spawn } from "node:child_process";
import { access, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = resolve("../..");
const appDirectory = resolve(".");
const piRpcEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
const piPackageDirectory = resolve(dirname(piRpcEntry), "..");
const workDirectory = resolve("../../.pi-dev/desktop-dev");
const resourcesDirectory = join(workDirectory, "resources");
const appResources = join(resourcesDirectory, "app");
const dataDirectory = resolve(process.env.PI_DESKTOP_DATA_DIR ?? "../../.pi-dev/desktop-data");

if (!workDirectory.startsWith(root) || !dataDirectory.startsWith(root))
	throw new Error("Development paths must stay inside the workspace");

await rm(workDirectory, { recursive: true, force: true });
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
await build({
	...common,
	entryPoints: [join(root, "packages", "desktop-pi-bridge", "src", "tool-bridge-extension.ts")],
	outfile: join(appResources, "extensions", "tool-bridge.mjs"),
});
await execFileAsync(process.execPath, [join(appDirectory, "scripts", "package-sidecar.mjs"), join(appResources, "sidecar")], {
	cwd: root,
	windowsHide: true,
	env: process.env,
});
await cp(join(piPackageDirectory, "dist", "modes", "interactive", "theme"), join(appResources, "dist", "modes", "interactive", "theme"), { recursive: true });
await access(join(appResources, "dist", "modes", "interactive", "theme", "dark.json"));
await cp(join(appDirectory, "src", "renderer"), join(appResources, "renderer"), { recursive: true });
await cp(join(root, "node_modules", "lucide", "dist", "esm"), join(appResources, "lucide"), { recursive: true });
await cp(join(piPackageDirectory, "node_modules", "@earendil-works"), join(appResources, "node_modules", "@earendil-works"), { recursive: true });
await cp(join(piPackageDirectory, "node_modules", "typebox"), join(appResources, "node_modules", "typebox"), { recursive: true });
await writeFile(join(workDirectory, "package.json"), JSON.stringify({ name: "pi-desktop-dev", private: true, type: "module", main: "main.mjs" }, null, 2));

const electronCli = join(root, "node_modules", "electron", "cli.js");
const child = spawn(process.execPath, [electronCli, join(workDirectory, "main.mjs")], {
	cwd: appDirectory,
	stdio: "inherit",
	env: {
		...process.env,
		PI_DESKTOP_RESOURCES_DIR: resourcesDirectory,
		PI_DESKTOP_DATA_DIR: dataDirectory,
		PI_DESKTOP_PORT: "4318",
		PI_DESKTOP_DEVTOOLS: "1",
	},
});

for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => {
	process.exitCode = code ?? 0;
});
