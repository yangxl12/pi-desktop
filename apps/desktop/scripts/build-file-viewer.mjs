import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(here, "..");
const force = process.argv.includes("--force");
const target =
	process.argv[2] && process.argv[2] !== "--force" && process.argv[2] !== "--commit"
		? resolve(process.argv[2])
		: join(appDirectory, "src", "renderer", "vendor", "open-file-viewer");
const root = resolve(appDirectory, "..", "..");
const coreDist = join(root, "node_modules", "@open-file-viewer", "core", "dist");
const mermaidDist = join(root, "node_modules", "mermaid", "dist");
const stampPath = join(target, ".build-stamp");

const optionalExternals = ["pdfjs-dist", "@mlightcad/*", "lodash-es"];

const packageJson = async (path) => {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return {};
	}
};

async function inputStamp() {
	const core = await packageJson(join(root, "node_modules", "@open-file-viewer", "core", "package.json"));
	const prism = await packageJson(join(root, "node_modules", "prismjs", "package.json"));
	const mermaid = await packageJson(join(root, "node_modules", "mermaid", "package.json"));
	const esbuild = await packageJson(join(root, "node_modules", "esbuild", "package.json"));
	const entryHashes = [];
	for (const name of ["file-viewer-entry.mjs", "file-viewer-prism-entry.mjs", "build-file-viewer.mjs", "../src/renderer/markdown-renderer.mjs"]) {
		entryHashes.push(createHash("sha1").update(await readFile(join(here, name))).digest("hex").slice(0, 12));
	}
	return JSON.stringify({
		core: core.version,
		prism: prism.version,
		mermaid: mermaid.version,
		esbuild: esbuild.version,
		entries: entryHashes,
	});
}

async function stampMatches() {
	if (force) return false;
	try {
		const [current, stored] = await Promise.all([inputStamp(), readFile(stampPath, "utf8")]);
		if (current !== stored) return false;
		for (const name of ["index.js", "markdown.js", "prism.js", "style.css", join("mermaid", "mermaid.esm.mjs")]) {
			try {
				await stat(join(target, name));
			} catch {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

if (await stampMatches()) {
	console.log(`${target} (up to date)`);
	process.exit(0);
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

// Main viewer bundle. Heavy lazy parts (mermaid diagrams, prism language
// components) stay external and are rewritten below to relative URLs so they
// load only when a preview actually needs them.
await build({
	entryPoints: [join(here, "file-viewer-entry.mjs")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	outfile: join(target, "index.js"),
	minify: true,
	// Optional peers the host does not install; the matching plugins are not used.
	// Node builtins (util/buffer/...) are pulled by unused plugins (psd/office);
	// tree shaking drops them from the output once the graph resolves.
	external: [...optionalExternals, "util", "buffer", "path", "stream", "events", "assert", "mermaid", "prismjs", "prismjs/components/*"],
	logLevel: "warning",
});

const bundle = await readFile(join(target, "index.js"), "utf8");
const rewritten = bundle
	// Prism component imports surface as either static hoisted `import "..."`
	// (CJS context) or dynamic `import("...")`; both must target the shared
	// prism bundle so components register on the same Prism instance.
	.replace(/import"prismjs\/components\/[^"]+"/g, 'import"./prism.js"')
	.replace(/import\("prismjs\/components\/[^"]+"\)/g, 'import("./prism.js")')
	.replace(/import\("prismjs"\)/g, 'import("./prism.js")')
	.replace(/import\("mermaid"\)/g, 'import("./mermaid/mermaid.esm.mjs")');
await writeFile(join(target, "index.js"), rewritten);

// Markdown is bundled separately so the renderer can use a full GFM parser
// without exposing node_modules through the local HTTP host.
await build({
	entryPoints: [join(appDirectory, "src", "renderer", "markdown-renderer.mjs")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	outfile: join(target, "markdown.js"),
	minify: true,
	logLevel: "warning",
});

// Prism core + all language components as one lazy module. The viewer code
// imports it for both `prismjs` and `prismjs/components/*`, and the single
// instance keeps `highlightElement` consistent with the registered languages.
await build({
	entryPoints: [join(here, "file-viewer-prism-entry.mjs")],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	outfile: join(target, "prism.js"),
	minify: true,
	logLevel: "warning",
});

// Mermaid's ESM entry plus its chunked modules. Only the ESM chunks are
// needed; CJS/typings/tests would add ~20 MB of dead weight.
const mermaidChunks = join(mermaidDist, "chunks", "mermaid.esm");
await mkdir(join(target, "mermaid", "chunks", "mermaid.esm"), { recursive: true });
await cp(join(mermaidDist, "mermaid.esm.mjs"), join(target, "mermaid", "mermaid.esm.mjs"));
for (const entry of await readdir(mermaidChunks)) {
	if (!entry.endsWith(".mjs")) continue;
	await cp(join(mermaidChunks, entry), join(target, "mermaid", "chunks", "mermaid.esm", entry));
}
await cp(join(coreDist, "style.css"), join(target, "style.css"));
await writeFile(stampPath, await inputStamp());

// Real-time AV scanning on Windows locks freshly written files; the first
// read then blocks for seconds per file. Warm the outputs once here so the
// delay is absorbed at build time instead of hanging the first page load.
for (const entry of await readdir(target, { recursive: true })) {
	const entryPath = join(target, entry);
	try {
		const info = await stat(entryPath);
		if (info.isFile()) await readFile(entryPath);
	} catch {
		// Best effort; stale outputs still resolve through the stamp check.
	}
}
console.log(target);
