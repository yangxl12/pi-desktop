import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/jsonl.ts";

describe("strict JSONL framing", () => {
	it("splits only on LF and preserves Unicode separators in strings", () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		const dispose = attachJsonlLineReader(stream, (line) => lines.push(line));
		stream.write(serializeJsonLine({ text: "one\u2028two\u2029three" }));
		stream.end();
		dispose();
		expect(lines).toEqual([JSON.stringify({ text: "one\u2028two\u2029three" })]);
	});
});
