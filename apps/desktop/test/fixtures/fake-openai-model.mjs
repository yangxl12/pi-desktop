import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const requests = [];
const logPath = process.env.FAKE_OPENAI_LOG_PATH;

function persist() {
	if (logPath) writeFileSync(logPath, JSON.stringify(requests), "utf8");
}

function chunk(model, delta, finishReason = null) {
	return {
		id: "chatcmpl-pi-desktop-fixture",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function sendEventStream(response, entries) {
	response.writeHead(200, {
		"cache-control": "no-cache",
		"content-type": "text/event-stream; charset=utf-8",
		connection: "keep-alive",
	});
	for (const entry of entries) response.write(`data: ${JSON.stringify(entry)}\n\n`);
	response.end("data: [DONE]\n\n");
}

const server = createServer((request, response) => {
	if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
		response.writeHead(404).end();
		return;
	}
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (value) => {
		body += value;
	});
	request.on("end", () => {
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			response.writeHead(400).end("invalid JSON");
			return;
		}
		requests.push(payload);
		persist();
		const model = typeof payload.model === "string" ? payload.model : "fake-model";
		const hasToolResult = Array.isArray(payload.messages) && payload.messages.some((message) => message?.role === "tool");
		if (hasToolResult) {
			sendEventStream(response, [
				chunk(model, { role: "assistant", content: "MCP echo completed" }),
				chunk(model, {}, "stop"),
			]);
			return;
		}
		const requestedToolName = process.env.FAKE_OPENAI_TOOL_NAME ?? "demo_echo";
		const toolArguments = process.env.FAKE_OPENAI_TOOL_ARGS ?? '{"value":"from-fake-model"}';
		const tool = Array.isArray(payload.tools)
			? payload.tools.find((item) => item?.type === "function" && item?.function?.name === requestedToolName)
			: undefined;
		const name = tool?.function?.name ?? requestedToolName;
		sendEventStream(response, [
			chunk(model, {
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "call-pi-desktop-echo",
						type: "function",
						function: { name, arguments: toolArguments },
					},
				],
			}),
			chunk(model, {}, "tool_calls"),
		]);
	});
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("Fixture did not receive a TCP address");
	console.log(JSON.stringify({ type: "ready", port: address.port }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => server.close(() => process.exit(0)));
}
