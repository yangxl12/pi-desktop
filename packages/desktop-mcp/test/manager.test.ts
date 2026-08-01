import { describe, expect, it } from "vitest";
import { McpManager } from "../src/index.ts";
import type { McpServerProfile } from "../src/types.ts";

function profile(overrides: Partial<McpServerProfile> = {}): McpServerProfile {
	return {
		id: "demo",
		name: "Demo",
		transport: "stdio",
		command: process.execPath,
		args: [],
		env: {},
		url: null,
		credentialRef: null,
		namespace: "demo",
		enabled: true,
		timeoutMs: 5_000,
		maxOutputBytes: 1_048_576,
		projectId: null,
		...overrides,
	};
}

describe("MCP manager", () => {
	it("starts a stdio server, discovers and calls a namespaced tool", async () => {
		const script = [
			"let b=''; process.stdin.on('data',c=>{b+=c; let i; while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); let r={jsonrpc:'2.0',id:m.id,result:{}}; if(m.method==='initialize') r.result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}; if(m.method==='tools/list') r.result={tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]}; if(m.method==='tools/call') r.result={content:[{type:'text',text:JSON.stringify(m.params.arguments)}]}; process.stdout.write(JSON.stringify(r)+'\\n');}});",
		].join(" ");
		const manager = new McpManager();
		const snapshot = await manager.start(profile({ args: ["-e", script] }));
		expect(snapshot.status).toBe("ready");
		expect(manager.listTools()).toEqual([expect.objectContaining({ namespacedName: "demo.echo" })]);
		const result = await manager.callTool("demo.echo", { value: 1 }, { projectId: null, trusted: true });
		expect(result.content[0]).toMatchObject({ type: "text", text: '{"value":1}' });
		await manager.stopAll();
	});

	it("rejects invalid profiles before spawning", async () => {
		const manager = new McpManager();
		await expect(manager.start(profile({ timeoutMs: 10 }))).rejects.toThrow("timeout");
	});
});
