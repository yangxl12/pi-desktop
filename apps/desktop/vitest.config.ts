import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (relativePath: string) => fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-desktop-protocol": source("../../packages/desktop-protocol/src/index.ts"),
			"@earendil-works/pi-desktop-core": source("../../packages/desktop-core/src/index.ts"),
			"@earendil-works/pi-desktop-pi-bridge": source("../../packages/desktop-pi-bridge/src/index.ts"),
			"@earendil-works/pi-desktop-storage": source("../../packages/desktop-storage/src/index.ts"),
			"@earendil-works/pi-desktop-mcp": source("../../packages/desktop-mcp/src/index.ts"),
		},
	},
});

