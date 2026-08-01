import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const protocol = fileURLToPath(new URL("../desktop-protocol/src/index.ts", import.meta.url));
const core = fileURLToPath(new URL("../desktop-core/src/index.ts", import.meta.url));

export default defineConfig({
	test: { environment: "node" },
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-desktop-protocol$/, replacement: protocol },
			{ find: /^@earendil-works\/pi-desktop-core$/, replacement: core },
		],
	},
});
