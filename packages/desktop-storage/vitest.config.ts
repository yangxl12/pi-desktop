import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const core = fileURLToPath(new URL("../desktop-core/src/index.ts", import.meta.url));
const protocol = fileURLToPath(new URL("../desktop-protocol/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-desktop-core$/, replacement: core },
			{ find: /^@earendil-works\/pi-desktop-protocol$/, replacement: protocol },
		],
	},
});
