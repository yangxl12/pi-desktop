import type { DesktopCommand, DesktopRequest } from "./commands.ts";
import { DesktopError } from "./errors.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === "string";
}

function isModelProfileDraft(value: unknown): boolean {
	return (
		isRecord(value) &&
		isNonEmptyString(value.providerId) &&
		isNonEmptyString(value.displayName) &&
		isNonEmptyString(value.baseUrl) &&
		isNonEmptyString(value.modelId) &&
		typeof value.enabled === "boolean" &&
		(value.protocol === undefined ||
			["openai-compatible", "anthropic", "local", "custom"].includes(value.protocol as string)) &&
		(value.credentialStrategy === undefined ||
			["none", "api-key", "oauth", "os-secret"].includes(value.credentialStrategy as string)) &&
		(value.capabilities === undefined || isModelCapabilities(value.capabilities))
	);
}

function isModelCapabilities(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.streaming === "boolean" &&
		typeof value.toolCalling === "boolean" &&
		typeof value.thinking === "boolean" &&
		typeof value.multimodal === "boolean" &&
		(value.contextWindow === undefined || (Number.isInteger(value.contextWindow) && Number(value.contextWindow) > 0))
	);
}

function isModelProfilePatch(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	if (
		!keys.every((key) =>
			[
				"providerId",
				"displayName",
				"baseUrl",
				"modelId",
				"enabled",
				"protocol",
				"capabilities",
				"credentialStrategy",
			].includes(key),
		)
	)
		return false;
	return keys.every((key) => {
		if (key === "enabled") return typeof value[key] === "boolean";
		if (key === "protocol")
			return ["openai-compatible", "anthropic", "local", "custom"].includes(value[key] as string);
		if (key === "credentialStrategy") return ["none", "api-key", "oauth", "os-secret"].includes(value[key] as string);
		if (key === "capabilities") return isModelCapabilities(value[key]);
		return isNonEmptyString(value[key]);
	});
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isSkillSource(value: unknown): boolean {
	return (
		isRecord(value) &&
		["npm", "git", "url", "local", "external"].includes(value.kind as string) &&
		isNonEmptyString(value.spec) &&
		(value.version === undefined || value.version === null || typeof value.version === "string") &&
		(value.ref === undefined || value.ref === null || typeof value.ref === "string")
	);
}

function isMcpServerDraft(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		isNonEmptyString(value.name) &&
		(value.transport === "stdio" || value.transport === "http") &&
		(value.command === null || typeof value.command === "string") &&
		isStringArray(value.args) &&
		isStringRecord(value.env) &&
		(value.url === null || typeof value.url === "string") &&
		(value.credentialRef === null || typeof value.credentialRef === "string") &&
		isNonEmptyString(value.namespace) &&
		typeof value.enabled === "boolean" &&
		Number.isInteger(value.timeoutMs) &&
		Number.isInteger(value.maxOutputBytes) &&
		(value.projectId === null || typeof value.projectId === "string") &&
		(value.launchKind === undefined || ["http", "managed-npm", "executable"].includes(value.launchKind as string)) &&
		(value.packageSpec === undefined || value.packageSpec === null || typeof value.packageSpec === "string") &&
		(value.packageVersion === undefined ||
			value.packageVersion === null ||
			typeof value.packageVersion === "string") &&
		(value.bin === undefined || value.bin === null || typeof value.bin === "string") &&
		(value.secretEnvRefs === undefined || isStringRecord(value.secretEnvRefs)) &&
		(value.secretHeaderRefs === undefined || isStringRecord(value.secretHeaderRefs)) &&
		(value.scope === undefined || ["global", "project"].includes(value.scope as string))
	);
}

function isMcpServerPatch(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const allowed = [
		"name",
		"transport",
		"command",
		"args",
		"env",
		"url",
		"credentialRef",
		"namespace",
		"enabled",
		"timeoutMs",
		"maxOutputBytes",
		"projectId",
		"launchKind",
		"packageSpec",
		"packageVersion",
		"bin",
		"secretEnvRefs",
		"secretHeaderRefs",
		"scope",
	];
	if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
	return isMcpServerDraft({
		name: "server",
		transport: "stdio",
		command: null,
		args: [],
		env: {},
		url: null,
		credentialRef: null,
		namespace: "server",
		enabled: false,
		timeoutMs: 30_000,
		maxOutputBytes: 1_048_576,
		projectId: null,
		...value,
	});
}

export function isDesktopCommand(value: unknown): value is DesktopCommand {
	if (!isRecord(value) || !isNonEmptyString(value.type)) return false;
	const type = value.type;
	if (
		type.startsWith("window.") ||
		type === "app.quit" ||
		type === "app.getState" ||
		type === "app.getDiagnostics" ||
		type === "app.exportDiagnostics"
	) {
		return [
			"window.show",
			"window.hide",
			"window.toggle",
			"window.minimize",
			"window.maximize",
			"window.closeToTray",
			"app.quit",
			"app.getState",
			"app.getDiagnostics",
			"app.exportDiagnostics",
		].includes(type);
	}
	if (
		type === "projects.list" ||
		type === "projects.addFromFolder" ||
		type === "models.list" ||
		type === "skills.list" ||
		type === "skills.reload" ||
		type === "settings.get" ||
		type === "agent.getState" ||
		type === "agent.getMessages" ||
		type === "agent.getCommands" ||
		type === "agent.retryLast" ||
		type === "agent.abort"
	)
		return true;
	if (type === "sessions.listAll") return true;
	if (type === "projects.add") return isNonEmptyString(value.rootPath);
	if (["projects.select", "projects.remove", "sessions.list", "sessions.rebuild"].includes(type))
		return (
			isNonEmptyString(value.projectId) &&
			(value.limit === undefined || (Number.isInteger(value.limit) && Number(value.limit) > 0)) &&
			(value.cursor === undefined || isNonEmptyString(value.cursor))
		);
	if (type === "projects.rename") return isNonEmptyString(value.projectId) && isNonEmptyString(value.name);
	if (type === "projects.setTrust")
		return (
			isNonEmptyString(value.projectId) && ["unknown", "trusted", "untrusted"].includes(value.trustState as string)
		);
	if (type === "sessions.create")
		return isNonEmptyString(value.projectId) && (value.title === undefined || typeof value.title === "string");
	if (["sessions.open", "sessions.rename", "sessions.refresh"].includes(type))
		return isNonEmptyString(value.sessionId) && (type !== "sessions.rename" || isNonEmptyString(value.title));
	if (type === "agent.prompt") return isNonEmptyString(value.text);
	if (type === "agent.setThinkingLevel")
		return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.level as string);
	if (type === "agent.setModel") return isNonEmptyString(value.profileId);
	if (type === "settings.update") return isRecord(value.patch);
	if (type === "settings.reset") return isNonEmptyString(value.key);
	if (type === "webSearch.update")
		return (
			["disabled", "brave", "tavily", "deepseek"].includes(value.provider as string) &&
			isOptionalString(value.apiKey) &&
			(value.clearCredential === undefined || typeof value.clearCredential === "boolean")
		);
	if (type === "models.setDefault") return value.profileId === null || isNonEmptyString(value.profileId);
	if (type === "models.delete") return isNonEmptyString(value.profileId);
	if (type === "models.testConnection") return isNonEmptyString(value.profileId);
	if (type === "models.create") return isModelProfileDraft(value.profile) && isOptionalString(value.apiKey);
	if (type === "models.update")
		return (
			isNonEmptyString(value.profileId) &&
			isModelProfilePatch(value.patch) &&
			isOptionalString(value.apiKey) &&
			(value.clearCredential === undefined || typeof value.clearCredential === "boolean")
		);
	if (type === "mcp.list") return true;
	if (type === "mcp.create") return isMcpServerDraft(value.profile);
	if (type === "mcp.update") return isNonEmptyString(value.serverId) && isMcpServerPatch(value.patch);
	if (type === "mcp.delete" || type === "mcp.testConnection") return isNonEmptyString(value.serverId);
	if (type === "mcp.retry") return isNonEmptyString(value.serverId);
	if (type === "mcp.testAndSave") return isMcpServerDraft(value.profile);
	if (type === "mcp.import")
		return (
			isNonEmptyString(value.json) &&
			(value.scope === undefined || ["global", "project"].includes(value.scope as string))
		);
	if (type === "mcp.inspect") return isNonEmptyString(value.source);
	if (type === "mcp.setEnabled") return isNonEmptyString(value.serverId) && typeof value.enabled === "boolean";
	if (type === "mcp.listTools") return value.projectId === undefined || isNonEmptyString(value.projectId);
	if (type === "mcp.consent.respond")
		return (
			isNonEmptyString(value.requestId) &&
			typeof value.approved === "boolean" &&
			(value.scope === undefined || ["once", "session", "project"].includes(value.scope as string))
		);
	if (type === "mcp.consent.revoke")
		return (
			(value.projectId === undefined || value.projectId === null || isNonEmptyString(value.projectId)) &&
			(value.toolName === undefined || isNonEmptyString(value.toolName))
		);
	if (type === "approval.respond") return isNonEmptyString(value.requestId) && typeof value.approved === "boolean";
	if (type === "skills.inspect") return isSkillSource(value.source);
	if (type === "skills.install")
		return (
			isSkillSource(value.source) &&
			(value.scope === undefined || ["global", "project"].includes(value.scope as string)) &&
			(value.operationId === undefined || isNonEmptyString(value.operationId))
		);
	if (type === "skills.import")
		return (
			isNonEmptyString(value.path) &&
			(value.scope === undefined || ["global", "project"].includes(value.scope as string)) &&
			(value.operationId === undefined || isNonEmptyString(value.operationId))
		);
	if (type === "skills.remove" || type === "skills.update")
		return (
			isNonEmptyString(value.installationId) &&
			(value.operationId === undefined || isNonEmptyString(value.operationId))
		);
	return false;
}

export function parseDesktopRequest(value: unknown): DesktopRequest {
	if (!isRecord(value) || !isNonEmptyString(value.requestId) || !isDesktopCommand(value.command)) {
		throw new DesktopError("INVALID_ARGUMENT", "Invalid desktop request");
	}
	return { requestId: value.requestId, command: value.command };
}
