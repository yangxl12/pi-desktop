import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = "C:/Users/Administrator/Desktop/agentLearn/pi-desktop";
const appDirectory = join(root, "apps/desktop");
const workDirectory = join(root, ".pi-dev/desktop-dev");
const appResources = join(workDirectory, "resources", "app");
const t0 = Date.now();
const step = (name) => console.log(`${String(Date.now() - t0).padStart(6)}ms  ${name}`);

const electronPath = join(root, "node_modules", "electron", "dist", "electron.exe");
const script = `Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'electron.exe' -and $_.ExecutablePath -eq '${electronPath}') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*${workDirectory}*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
step("killStaleProcesses(powershell)");
await rm(workDirectory, { recursive: true, force: true });
step("rm desktop-dev");
await mkdir(join(appResources, "renderer"), { recursive: true });
await mkdir(join(appResources, "extensions"), { recursive: true });
step("mkdir");

const piRpcEntry = fileURLToPath(
	await import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry", pathToFileURL(appDirectory + "/x.mjs")),
);
const piPackageDirectory = resolve(dirname(piRpcEntry), "..");
step("resolve pi rpc-entry");

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
step("build main.mjs (electron)");
await build({ ...common, entryPoints: [join(root, "apps/desktop/src/host/main.ts")], outfile: join(appResources, "host.mjs") });
step("build host.mjs");
await build({ ...common, entryPoints: [piRpcEntry], outfile: join(appResources, "rpc-entry.mjs") });
step("build rpc-entry.mjs");
await build({ ...common, entryPoints: [join(appDirectory, "src", "extensions", "web-search.ts")], outfile: join(appResources, "extensions", "web-search.mjs") });
step("build web-search.mjs");
await build({
	...common,
	entryPoints: [join(root, "packages", "desktop-pi-bridge", "src", "tool-bridge-extension.ts")],
	outfile: join(appResources, "extensions", "tool-bridge.mjs"),
});
step("build tool-bridge.mjs");
await execFileAsync(process.execPath, [join(appDirectory, "scripts", "package-sidecar.mjs"), join(appResources, "sidecar")], {
	cwd: root,
	windowsHide: true,
	env: process.env,
});
step("package-sidecar.mjs");
await cp(join(piPackageDirectory, "dist", "modes", "interactive", "theme"), join(appResources, "dist", "modes", "interactive", "theme"), { recursive: true });
step("cp theme");
await cp(join(appDirectory, "src", "renderer"), join(appResources, "renderer"), { recursive: true });
step("cp renderer");
await cp(join(root, "node_modules", "lucide", "dist", "esm"), join(appResources, "lucide"), { recursive: true });
step("cp lucide (3530 files)");
await cp(join(piPackageDirectory, "node_modules", "@earendil-works"), join(appResources, "node_modules", "@earendil-works"), { recursive: true });
step("cp @earendil-works");
await cp(join(piPackageDirectory, "node_modules", "typebox"), join(appResources, "node_modules", "typebox"), { recursive: true });
step("cp typebox");
await writeFile(join(workDirectory, "package.json"), JSON.stringify({ name: "pi-desktop-dev", private: true, type: "module", main: "main.mjs" }, null, 2));
step("write package.json");
console.log(`TOTAL ${Date.now() - t0}ms`);
