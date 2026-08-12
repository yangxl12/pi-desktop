import { Arch, Platform } from "electron-builder";

export const maximumAppAsarBytes = 5 * 1024 * 1024;

export function createWindowsBuildOptions(config, projectDir) {
	return {
		projectDir,
		targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64),
		publish: "never",
		config: {
			...config,
			// The application and its runtime dependencies are already bundled or
			// copied into extraResources. Prevent electron-builder from traversing
			// the npm workspace and adding those dependencies to app.asar again.
			beforeBuild: async () => false,
		},
	};
}

export function assertAppAsarSize(size) {
	if (size > maximumAppAsarBytes) {
		throw new Error(
			`Unexpected app.asar size: ${(size / (1024 * 1024)).toFixed(2)} MiB; workspace dependencies may have been packaged`,
		);
	}
}
