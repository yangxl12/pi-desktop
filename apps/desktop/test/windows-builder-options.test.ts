import { describe, expect, it } from "vitest";
import {
	assertAppAsarSize,
	createWindowsBuildOptions,
	maximumAppAsarBytes,
} from "../scripts/windows-builder-options.mjs";

describe("Windows electron-builder options", () => {
	it("marks bundled dependencies as externally handled", async () => {
		const config = { appId: "works.earendil.pi.desktop" };
		const options = createWindowsBuildOptions(config, "C:\\workspace\\apps\\desktop");

		expect(options.projectDir).toBe("C:\\workspace\\apps\\desktop");
		expect(options.publish).toBe("never");
		expect(options.config.appId).toBe(config.appId);
		expect(await options.config.beforeBuild()).toBe(false);
	});

	it("rejects an app.asar large enough to contain workspace dependencies", () => {
		expect(() => assertAppAsarSize(maximumAppAsarBytes)).not.toThrow();
		expect(() => assertAppAsarSize(maximumAppAsarBytes + 1)).toThrow(/workspace dependencies may have been packaged/);
	});
});
