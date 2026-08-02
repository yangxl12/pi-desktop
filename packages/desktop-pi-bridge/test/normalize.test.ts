import { describe, expect, it } from "vitest";
import { normalizeMessage, normalizePiEvent } from "../src/normalize.ts";

describe("Pi message normalization", () => {
	it("preserves tool results as visible tool activity", () => {
		const message = normalizeMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "web_search",
			content: [{ type: "text", text: "Source: https://example.com" }],
			isError: false,
			timestamp: 1,
		});
		expect(message.role).toBe("tool");
		expect(message.parts).toEqual([
			expect.objectContaining({
				type: "tool",
				toolName: "web_search",
				toolCallId: "call-1",
				status: "finished",
			}),
		]);
	});

	it("does not clear runtime fields when the agent settles", () => {
		expect(normalizePiEvent({ type: "agent_settled" })).toEqual({
			type: "state_changed",
			state: { isStreaming: false },
		});
	});
});
