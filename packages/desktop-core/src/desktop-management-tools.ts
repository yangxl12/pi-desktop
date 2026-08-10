import type {
	DesktopApprovalRequest,
	McpServerDraft,
	McpServerPatch,
	SkillInstallScope,
	SkillSource,
} from "@earendil-works/pi-desktop-protocol";
import type { McpPort, MetadataRepository } from "./ports.ts";
import type { RuntimeToolDefinition } from "./runtime-contract.ts";
import type { SkillInstallService } from "./skill-install-service.ts";

type ApprovalPreview = Omit<DesktopApprovalRequest, "requestId" | "createdAt">;

export interface DesktopManagementToolServices {
	skills?: SkillInstallService;
	mcp?: McpPort;
	metadata?: MetadataRepository;
	getProjectId?: () => string | null;
	approve?: (request: ApprovalPreview) => Promise<boolean>;
	inspectMcp?: (source: string) => Promise<Record<string, unknown>>;
	installMcp?: (profile: McpServerDraft) => Promise<unknown>;
	updateMcp?: (serverId: string, patch: McpServerPatch) => Promise<unknown>;
	removeMcp?: (serverId: string) => Promise<unknown>;
}

function json(content: unknown) {
	return { content: [{ type: "text", text: JSON.stringify(content) }] };
}

async function requireApproval(services: DesktopManagementToolServices, request: ApprovalPreview): Promise<void> {
	if (!(await services.approve?.(request))) throw new Error("Desktop operation was denied");
}

/** Host-owned tools. Every mutating operation passes through the same application approval broker. */
export function createDesktopManagementTools(services: DesktopManagementToolServices): RuntimeToolDefinition[] {
	const projectId = () => services.getProjectId?.() ?? null;
	const tools: RuntimeToolDefinition[] = [];
	if (services.skills) {
		const skills = services.skills;
		tools.push(
			{
				name: "desktop_list_skills",
				description: "List installed skills and their verified load status.",
				parameters: { type: "object", properties: {} },
				call: async () => json(await skills.list()),
			},
			{
				name: "desktop_inspect_skill_source",
				description: "Inspect a skill package source before installation.",
				parameters: {
					type: "object",
					properties: { kind: { type: "string" }, spec: { type: "string" }, scope: { type: "string" } },
					required: ["kind", "spec"],
				},
				call: async (args) =>
					json(
						await skills.inspect(
							{ kind: String(args.kind), spec: String(args.spec) } as SkillSource,
							(args.scope as SkillInstallScope) ?? "global",
						),
					),
			},
			{
				name: "desktop_install_skill",
				description: "Inspect and request approval to install a skill.",
				parameters: {
					type: "object",
					properties: { kind: { type: "string" }, spec: { type: "string" }, scope: { type: "string" } },
					required: ["kind", "spec"],
				},
				call: async (args) => {
					const source = { kind: String(args.kind), spec: String(args.spec) } as SkillSource;
					const scope = (args.scope as SkillInstallScope) ?? "global";
					const inspection = await skills.inspect(source, scope);
					await requireApproval(services, {
						operation: "skill.install",
						title: `Install Skill ${inspection.name ?? source.spec}`,
						summary: `${source.kind}:${source.spec} / ${scope}`,
						risks: inspection.risk,
					});
					return json(await skills.install(source, scope));
				},
			},
			{
				name: "desktop_remove_skill",
				description: "Request approval to remove an installed skill.",
				parameters: {
					type: "object",
					properties: { installationId: { type: "string" } },
					required: ["installationId"],
				},
				call: async (args) => {
					const item = (await skills.list()).find((candidate) => candidate.id === args.installationId);
					if (!item) throw new Error("Skill installation not found");
					await requireApproval(services, {
						operation: "skill.remove",
						title: `Remove Skill ${item.name ?? item.id}`,
						summary: item.source.spec,
						risks: ["The Skill command will no longer be available"],
					});
					await skills.remove(item);
					return json({ removed: item.id });
				},
			},
		);
	}
	if (services.mcp) {
		const mcp = services.mcp;
		tools.push(
			{
				name: "desktop_list_mcp_servers",
				description: "List configured MCP servers with connection and Agent availability state.",
				parameters: { type: "object", properties: {} },
				call: async () => json(mcp.list()),
			},
			{
				name: "desktop_inspect_mcp_source",
				description: "Normalize and inspect an MCP server source before installation.",
				parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
				call: async (args) => json(await services.inspectMcp?.(String(args.source))),
			},
			{
				name: "desktop_install_mcp_server",
				description: "Inspect and request approval to install, connect, and expose an MCP server.",
				parameters: {
					type: "object",
					properties: { source: { type: "string" }, scope: { type: "string" } },
					required: ["source"],
				},
				call: async (args) => {
					if (!services.inspectMcp || !services.installMcp) throw new Error("MCP installation is unavailable");
					const inspection = await services.inspectMcp(String(args.source));
					const normalized = inspection.normalized as McpServerDraft | undefined;
					if (!normalized) throw new Error("MCP source could not be normalized");
					const scope: "global" | "project" = args.scope === "global" ? "global" : "project";
					const profile = {
						...normalized,
						scope,
						projectId: scope === "project" ? projectId() : null,
					};
					await requireApproval(services, {
						operation: "mcp.install",
						title: `Install MCP server ${profile.name}`,
						summary: `${profile.launchKind ?? profile.transport} / ${profile.packageSpec ?? profile.command ?? profile.url}`,
						risks: Array.isArray(inspection.risks)
							? inspection.risks.filter((risk): risk is string => typeof risk === "string")
							: ["Runs third-party tools"],
					});
					return json(await services.installMcp(profile));
				},
			},
			{
				name: "desktop_test_mcp_server",
				description: "Test an MCP server with an isolated temporary connection.",
				parameters: {
					type: "object",
					properties: { serverId: { type: "string" } },
					required: ["serverId"],
				},
				call: async (args) => {
					const profile = mcp.list().find((candidate) => candidate.profile.id === args.serverId)?.profile;
					if (!profile) throw new Error("MCP server not found");
					return json(await mcp.test(profile));
				},
			},
			{
				name: "desktop_update_mcp_server",
				description: "Request approval to update an MCP server configuration.",
				parameters: {
					type: "object",
					properties: { serverId: { type: "string" }, patch: { type: "object" } },
					required: ["serverId", "patch"],
				},
				call: async (args) => {
					if (!services.updateMcp) throw new Error("MCP update is unavailable");
					const serverId = String(args.serverId);
					const profile = mcp.list().find((candidate) => candidate.profile.id === serverId)?.profile;
					if (!profile) throw new Error("MCP server not found");
					if (typeof args.patch !== "object" || args.patch === null || Array.isArray(args.patch))
						throw new Error("MCP update patch must be an object");
					await requireApproval(services, {
						operation: "mcp.update",
						title: `Update MCP server ${profile.name}`,
						summary: JSON.stringify(args.patch),
						risks: ["The server connection and Agent tools may be restarted"],
					});
					return json(await services.updateMcp(serverId, args.patch as McpServerPatch));
				},
			},
			{
				name: "desktop_remove_mcp_server",
				description: "Request approval to remove an MCP server profile and managed package.",
				parameters: {
					type: "object",
					properties: { serverId: { type: "string" } },
					required: ["serverId"],
				},
				call: async (args) => {
					const serverId = String(args.serverId);
					const profile = mcp.list().find((candidate) => candidate.profile.id === serverId)?.profile;
					if (!profile) throw new Error("MCP server not found");
					await requireApproval(services, {
						operation: "mcp.remove",
						title: `Remove MCP server ${profile.name}`,
						summary: profile.packageSpec ?? profile.command ?? profile.url ?? profile.id,
						risks: ["Its tools will immediately become unavailable"],
					});
					if (services.removeMcp) await services.removeMcp(serverId);
					else {
						await mcp.stop(serverId, "removed by agent");
						await services.metadata?.deleteMcpServer(serverId);
					}
					return json({ removed: serverId });
				},
			},
		);
	}
	return tools;
}
