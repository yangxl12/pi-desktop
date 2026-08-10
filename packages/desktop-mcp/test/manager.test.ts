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

function fakeServerScript(inputSchema: Record<string, unknown> = { type: "object" }, delayMs = 0): string {
	const delayedCall =
		delayMs > 0
			? `if(m.method==='tools/call'){setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ok'}]}})+'\\n'),${delayMs});continue;}`
			: "if(m.method==='tools/call') r.result={content:[{type:'text',text:'ok'}]};";
	return [
		`const inputSchema=${JSON.stringify(inputSchema)};`,
		"let b=''; process.stdin.on('data',c=>{b+=c; let i; while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); let r={jsonrpc:'2.0',id:m.id,result:{}}; if(m.method==='initialize') r.result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}; if(m.method==='tools/list') r.result={tools:[{name:'echo',inputSchema}]};",
		delayedCall,
		"process.stdout.write(JSON.stringify(r)+'\\n');}});",
	].join(" ");
}

describe("MCP manager", () => {
	it("starts a stdio server, discovers and calls a namespaced tool", async () => {
		const script = [
			"let b=''; process.stdin.on('data',c=>{b+=c; let i; while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); let r={jsonrpc:'2.0',id:m.id,result:{}}; if(m.method==='initialize') r.result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}; if(m.method==='tools/list') r.result={tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]}; if(m.method==='tools/call') r.result={content:[{type:'text',text:JSON.stringify(m.params.arguments)}]}; process.stdout.write(JSON.stringify(r)+'\\n');}});",
		].join(" ");
		const manager = new McpManager();
		const snapshot = await manager.start(profile({ args: ["-e", script] }));
		expect(snapshot.status).toBe("ready");
		expect(snapshot.serverInfo).toEqual({ name: "fake", version: "1" });
		expect(snapshot.capabilities).toEqual(expect.objectContaining({ tools: {} }));
		expect(manager.listTools()).toEqual([expect.objectContaining({ namespacedName: "demo.echo" })]);
		const result = await manager.callTool("demo.echo", { value: 1 }, { projectId: null, trusted: true });
		expect(result.content[0]).toMatchObject({ type: "text", text: '{"value":1}' });
		await manager.stopAll();
	});

	it("rejects invalid profiles before spawning", async () => {
		const manager = new McpManager();
		await expect(manager.start(profile({ timeoutMs: 10 }))).rejects.toThrow("timeout");
	});

	it("tests a profile without stopping its active connection", async () => {
		const script = [
			"let b=''; process.stdin.on('data',c=>{b+=c; let i; while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i)); b=b.slice(i+1); let r={jsonrpc:'2.0',id:m.id,result:{}}; if(m.method==='initialize') r.result={protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}; if(m.method==='tools/list') r.result={tools:[{name:'echo',inputSchema:{type:'object'}}]}; if(m.method==='tools/call') r.result={content:[{type:'text',text:'active'}]}; process.stdout.write(JSON.stringify(r)+'\\n');}});",
		].join(" ");
		const manager = new McpManager();
		const activeProfile = profile({ args: ["-e", script] });
		await manager.start(activeProfile);
		expect((await manager.test(activeProfile)).status).toBe("ready");
		expect(manager.list()).toEqual([expect.objectContaining({ profile: expect.objectContaining({ id: "demo" }) })]);
		await expect(manager.callTool("demo.echo", {}, { projectId: null, trusted: true })).resolves.toMatchObject({
			content: [{ type: "text", text: "active" }],
		});
		await manager.stopAll();
	});

	it("rejects invalid and oversized tool input before the server receives it", async () => {
		const manager = new McpManager({ maxInputBytes: 1_024 });
		await manager.start(
			profile({
				args: [
					"-e",
					fakeServerScript({
						type: "object",
						properties: { value: { type: "string" } },
						required: ["value"],
						additionalProperties: false,
					}),
				],
			}),
		);

		await expect(manager.callTool("demo.echo", { value: 1 }, { projectId: null, trusted: true })).rejects.toThrow(
			"does not match schema type string",
		);
		await expect(
			manager.callTool("demo.echo", { value: "x".repeat(2_048) }, { projectId: null, trusted: true }),
		).rejects.toThrow("input exceeds 1024 byte limit");
		await manager.stopAll();
	});

	it("limits concurrent tool calls before dispatching another server request", async () => {
		const manager = new McpManager({ maxConcurrentCalls: 1, maxCallsPerMinute: 10 });
		await manager.start(profile({ args: ["-e", fakeServerScript({ type: "object" }, 75)] }));

		const first = manager.callTool("demo.echo", {}, { projectId: null, trusted: true });
		await expect(manager.callTool("demo.echo", {}, { projectId: null, trusted: true })).rejects.toThrow(
			"concurrent tool call limit of 1",
		);
		await expect(first).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
		await manager.stopAll();
	});

	it("applies a rolling per-tool rate limit", async () => {
		const manager = new McpManager({ maxCallsPerMinute: 1 });
		await manager.start(profile({ args: ["-e", fakeServerScript()] }));

		await expect(manager.callTool("demo.echo", {}, { projectId: null, trusted: true })).resolves.toMatchObject({
			content: [{ type: "text", text: "ok" }],
		});
		await expect(manager.callTool("demo.echo", {}, { projectId: null, trusted: true })).rejects.toThrow(
			"rate limit of 1 calls per minute",
		);
		await manager.stopAll();
	});
});
