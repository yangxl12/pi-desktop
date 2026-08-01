import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const protocol = fileURLToPath(new URL("../desktop-protocol/src/index.ts", import.meta.url));
const bridge = fileURLToPath(new URL("../desktop-pi-bridge/src/index.ts", import.meta.url));

export default defineConfig({
	test: { environment: "node" },
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-desktop-protocol$/, replacement: protocol },
			{ find: /^@earendil-works\/pi-desktop-pi-bridge$/, replacement: bridge },
		],
	},
});
