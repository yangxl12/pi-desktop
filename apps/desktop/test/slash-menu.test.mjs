import { describe, expect, it } from "vitest";
import {
	commandTokenAtCaret,
	cycleSelection,
	filterSlashCommands,
	replaceCommandToken,
} from "../src/renderer/slash-menu.mjs";

describe("slash command menu", () => {
	it("matches only the command token at the first-line caret", () => {
		expect(commandTokenAtCaret("  /rev", 6)).toEqual({ start: 2, end: 6, query: "rev", token: "/rev" });
		expect(commandTokenAtCaret("hello /rev", 10)).toBeNull();
		expect(commandTokenAtCaret("/rev\nnext", 4)).toEqual({ start: 0, end: 4, query: "rev", token: "/rev" });
		expect(commandTokenAtCaret("/rev\nnext", 9)).toBeNull();
	});

	it("ranks results, wraps selection, and replaces only the active token", () => {
		const commands = [
			{ name: "review-code", source: "extension" },
			{ name: "project-review", source: "skill" },
			{ name: "review", source: "skill" },
		];
		expect(filterSlashCommands(commands, "rev").map((command) => command.name)).toEqual([
			"review",
			"review-code",
			"project-review",
		]);
		expect(cycleSelection(3, 0, -1)).toBe(2);
		expect(replaceCommandToken("  /rev suffix", 6, "review")).toEqual({
			text: "  /review  suffix",
			caret: 10,
		});
	});
});
