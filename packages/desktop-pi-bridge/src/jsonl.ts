import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	onError?: (error: Error) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const emitLine = (line: string): void => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	const onData = (chunk: string | Buffer): void => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex < 0) return;
			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};
	const onEnd = (): void => {
		buffer += decoder.end();
		if (buffer) emitLine(buffer);
		buffer = "";
	};
	const onStreamError = (error: Error): void => onError?.(error);
	stream.on("data", onData);
	stream.on("end", onEnd);
	stream.on("error", onStreamError);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
		stream.off("error", onStreamError);
	};
}
