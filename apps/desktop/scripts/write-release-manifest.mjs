import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifestPath = resolve("release-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
const output = resolve(process.argv.slice(2).find((value) => value !== "--") ?? "release-manifest.generated.json");
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(output);
