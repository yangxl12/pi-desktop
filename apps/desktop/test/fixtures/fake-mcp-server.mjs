import { appendFileSync } from "node:fs";

let buffer = "";

function recordCall(argumentsValue) {
	const path = process.env.FAKE_MCP_LOG_PATH;
	if (!path) return;
	appendFileSync(path, `${JSON.stringify(argumentsValue)}\n`, "utf8");
}

function respond(id, result) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index = buffer.indexOf("\n");
	while (index >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.method === "initialize")
			respond(message.id, {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "pi-desktop-fixture", version: "1.0.0" },
			});
		else if (message.method === "tools/list")
			respond(message.id, {
				tools: [
					{
						name: "echo",
						description: "Echo fixture arguments",
						inputSchema: { type: "object", additionalProperties: true },
					},
				],
			});
		else if (message.method === "tools/call")
			{
				recordCall(message.params?.arguments ?? {});
			respond(message.id, {
				content: [{ type: "text", text: JSON.stringify(message.params?.arguments ?? {}) }],
			});
			}
	}
});
