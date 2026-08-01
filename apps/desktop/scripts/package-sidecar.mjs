import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { platform, arch } from "node:process";

const expectedNode = JSON.parse(await readFile(resolve("package.json"), "utf8")).engines.node.replace(">=", "");
const [requiredMajor, requiredMinor, requiredPatch] = expectedNode.split(".").map(Number);
const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < requiredMajor || (major === requiredMajor && (minor < requiredMinor || (minor === requiredMinor && patch < requiredPatch)))) throw new Error(`Packaging requires Node >=${expectedNode}; found ${process.version}`);
const target = `${platform}-${arch}`;
const output = resolve(process.argv[2] ?? "dist-sidecar", target);
await mkdir(output, { recursive: true });
const executable = process.execPath;
const destination = join(output, platform === "win32" ? "node.exe" : "node");
await cp(executable, destination);
if (platform !== "win32") await chmod(destination, 0o755);
await writeFile(join(output, "runtime.json"), JSON.stringify({ node: process.version, target, executable: basename(destination) }, null, 2));
console.log(output);
