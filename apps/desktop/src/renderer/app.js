import { createElement, icons } from "/vendor/lucide/lucide.mjs";

let desktopState = null;
let settingsOpen = false;
let settingsTab = "models";
let editingModelId = null;
let selectedQueue = null;
let slashItems = [];
let slashIndex = 0;
let toastTimer;
let eventSource;
let fallbackRefreshTimer;
let refreshTimer;
let renderFrame;
let durationTicker;
let sessionsByProject = new Map();
const collapsedProjects = new Set();
const reasoningOpen = new Map();
const responseStartedAt = new Map();
const responseDurations = new Map();
let contextMenuTarget = null;

const translations = {
	"zh-CN": {
		"app.title": "Pi 桌面端",
		"agent.local": "本地智能体",
		"project.none": "未选择项目",
		"session.new": "新对话",
		"session.rename": "重命名对话",
		"project.rename": "重命名项目",
		"projects": "项目",
		"projects.add": "添加项目",
		"projects.addHint": "添加本地项目文件夹后开始使用。",
		"history": "历史对话",
		"history.empty": "暂无历史对话",
		"runtime.none": "未启动运行时",
		"settings": "设置",
		"model": "模型",
		"thinking": "思考强度",
		"thinking.off": "关闭",
		"thinking.minimal": "极低",
		"thinking.low": "低",
		"thinking.medium": "中",
		"thinking.high": "高",
		"thinking.xhigh": "很高",
		"thinking.max": "最高",
		"thinking.activity": "思考、搜索与工具调用",
		"message.you": "你",
		"message.ai": "Pi",
		"message.tool": "工具",
		"message.copy": "复制消息",
		"message.empty": "Pi 已准备好在此项目中工作。",
		"prompt.placeholder": "请输入",
		"prompt.hint": "Enter 发送，Shift+Enter 换行",
		"prompt.clear": "清空消息",
		"prompt.send": "发送消息",
		"prompt.stop": "停止生成",
		"prompt.resize": "调整输入框高度",
		"trust.required": "需要确认项目可信状态",
		"trust.restricted": "项目受限",
		"trust.keep": "保持受限",
		"trust.allow": "信任项目",
		"settings.models": "模型",
		"settings.general": "通用",
		"settings.skills": "技能",
		"settings.mcp": "MCP",
		"settings.diagnostics": "诊断",
		"settings.back": "返回对话",
		"settings.language": "语言",
		"settings.theme": "主题",
		"settings.themeHint": "选择应用界面使用的颜色主题。",
		"theme.light": "浅色",
		"theme.dark": "深色",
		"settings.shortcut": "全局快捷键",
		"settings.window": "窗口行为",
		"settings.closeToTray": "关闭窗口时保留在系统托盘",
		"settings.webSearch": "联网搜索",
		"settings.provider": "搜索服务",
		"settings.apiKey": "API 密钥",
		"settings.apiKeyStored": "密钥已安全保存，留空则保持不变",
		"settings.save": "保存",
		"settings.reset": "恢复默认",
		"settings.disabled": "关闭",
		"settings.clearKey": "删除已保存的密钥",
		"settings.globalPrompt": "全局系统提示词",
		"settings.skillsDirectories": "技能目录",
		"settings.rescan": "重新扫描",
		"settings.loadedCommands": "已加载命令",
		"settings.noSkills": "没有已加载的技能",
		"settings.noModels": "没有模型配置",
		"settings.addModel": "添加模型",
		"settings.editModel": "编辑模型",
		"settings.name": "名称",
		"settings.configured": "已配置",
		"settings.providerId": "服务商 ID",
		"settings.baseUrl": "基础 URL",
		"settings.modelId": "模型 ID",
		"settings.profiles": "配置列表",
		"settings.directories": "目录",
		"settings.enabled": "启用",
		"settings.cancel": "取消",
		"settings.default": "设为默认模型",
		"settings.defaultModel": "默认模型",
		"settings.test": "测试连接",
		"settings.delete": "删除",
		"settings.runtime": "运行时",
		"settings.recentEvents": "近期事件",
		"settings.export": "导出诊断",
		"settings.add": "添加",
		"settings.noMcp": "没有 MCP 服务",
		"settings.addServer": "添加服务",
		"settings.namespace": "命名空间",
		"settings.transport": "传输方式",
		"settings.command": "命令",
		"settings.arguments": "参数（每行一个）",
		"settings.httpUrl": "HTTP URL",
		"settings.status": "状态",
		"settings.sessionFile": "会话文件",
		"settings.noDiagnostics": "没有诊断记录",
		"toast.saved": "已保存",
		"toast.copied": "消息已复制",
		"toast.modelSaved": "模型已保存",
		"toast.modelDeleted": "模型已删除",
		"toast.defaultModel": "默认模型已更新",
		"toast.windowSaved": "窗口行为已保存",
		"toast.skillAdded": "技能目录已添加",
		"toast.skillRemoved": "技能目录已移除",
		"toast.skillsRescanned": "技能已重新扫描",
		"toast.mcpUpdated": "MCP 服务已更新",
		"toast.mcpDeleted": "MCP 服务已删除",
		"toast.mcpConnected": "MCP 连接成功",
		"toast.mcpFailed": "MCP 连接失败",
		"confirm.deleteModel": "删除此模型配置？",
		"confirm.deleteMcp": "删除此 MCP 服务？",
		"prompt.sessionName": "对话名称",
		"prompt.projectName": "项目名称",
		"runtime.failed": "运行时失败",
		"retry": "重试",
		"streaming": "生成中",
		"stream.steer": "插入指令",
		"stream.follow": "完成后继续",
		"queue.choose": "生成中请选择插入方式",
		"context.rename": "重命名",
		"message.processing": "处理中...",
		"message.processed": "已处理",
		"settings.defaultThinking": "默认思考强度",
		"settings.fontSize": "字体大小",
		"settings.conversationFontSize": "对话字体",
		"settings.sidebarFontSize": "侧栏字体",
		"settings.fontSizeHint": "调整后应用于对话内容和左侧项目、标题、历史列表。",
		"toast.fontSizeSaved": "字体大小已更新",
		"toast.themeSaved": "主题已更新",
	},
	en: {
		"app.title": "Pi Desktop",
		"agent.local": "LOCAL AGENT",
		"project.none": "No project selected",
		"session.new": "New conversation",
		"session.rename": "Rename session",
		"project.rename": "Rename project",
		"projects": "Projects",
		"projects.add": "Add project",
		"projects.addHint": "Add a local project folder to begin.",
		"history": "Conversation history",
		"history.empty": "No conversation history",
		"runtime.none": "No runtime",
		"settings": "Settings",
		"model": "Model",
		"thinking": "Thinking",
		"thinking.off": "Off",
		"thinking.minimal": "Minimal",
		"thinking.low": "Low",
		"thinking.medium": "Medium",
		"thinking.high": "High",
		"thinking.xhigh": "X-high",
		"thinking.max": "Max",
		"thinking.activity": "Thinking, search, and tool activity",
		"message.you": "You",
		"message.ai": "Pi",
		"message.tool": "Tool",
		"message.copy": "Copy message",
		"message.empty": "Pi is ready to work in this project.",
		"prompt.placeholder": "Please enter",
		"prompt.hint": "Enter to send; Shift+Enter for a new line",
		"prompt.clear": "Clear message",
		"prompt.send": "Send message",
		"prompt.stop": "Stop response",
		"prompt.resize": "Adjust input height",
		"trust.required": "Project trust required",
		"trust.restricted": "Restricted project",
		"trust.keep": "Keep restricted",
		"trust.allow": "Trust project",
		"settings.models": "Models",
		"settings.general": "General",
		"settings.skills": "Skills",
		"settings.mcp": "MCP",
		"settings.diagnostics": "Diagnostics",
		"settings.back": "Back to chat",
		"settings.language": "Language",
		"settings.theme": "Theme",
		"settings.themeHint": "Choose the color theme used across Pi Desktop.",
		"theme.light": "Light",
		"theme.dark": "Dark",
		"settings.shortcut": "Global shortcut",
		"settings.window": "Window behavior",
		"settings.closeToTray": "Keep Pi Desktop in the system tray when the window closes",
		"settings.webSearch": "Web search",
		"settings.provider": "Search provider",
		"settings.apiKey": "API key",
		"settings.apiKeyStored": "Stored securely; leave blank to keep",
		"settings.save": "Save",
		"settings.reset": "Reset",
		"settings.disabled": "Disabled",
		"settings.clearKey": "Remove saved key",
		"settings.globalPrompt": "Global system prompt",
		"settings.skillsDirectories": "Skill directories",
		"settings.rescan": "Rescan",
		"settings.loadedCommands": "Loaded commands",
		"settings.noSkills": "No skills loaded",
		"settings.noModels": "No model profiles",
		"settings.addModel": "Add model",
		"settings.editModel": "Edit model",
		"settings.name": "Name",
		"settings.configured": "configured",
		"settings.providerId": "Provider ID",
		"settings.baseUrl": "Base URL",
		"settings.modelId": "Model ID",
		"settings.profiles": "Profiles",
		"settings.directories": "Directories",
		"settings.enabled": "Enabled",
		"settings.cancel": "Cancel",
		"settings.default": "Set as default",
		"settings.defaultModel": "Default model",
		"settings.test": "Test connection",
		"settings.delete": "Delete",
		"settings.runtime": "Runtime",
		"settings.recentEvents": "Recent events",
		"settings.export": "Export diagnostics",
		"settings.add": "Add",
		"settings.noMcp": "No MCP servers",
		"settings.addServer": "Add server",
		"settings.namespace": "Namespace",
		"settings.transport": "Transport",
		"settings.command": "Command",
		"settings.arguments": "Arguments (one per line)",
		"settings.httpUrl": "HTTP URL",
		"settings.status": "Status",
		"settings.sessionFile": "Session file",
		"settings.noDiagnostics": "No diagnostics",
		"toast.saved": "Saved",
		"toast.copied": "Message copied",
		"toast.modelSaved": "Model saved",
		"toast.modelDeleted": "Model deleted",
		"toast.defaultModel": "Default model updated",
		"toast.windowSaved": "Window behavior saved",
		"toast.skillAdded": "Skill directory added",
		"toast.skillRemoved": "Skill directory removed",
		"toast.skillsRescanned": "Skills rescanned",
		"toast.mcpUpdated": "MCP server updated",
		"toast.mcpDeleted": "MCP server deleted",
		"toast.mcpConnected": "MCP connection successful",
		"toast.mcpFailed": "MCP connection failed",
		"confirm.deleteModel": "Delete this model profile?",
		"confirm.deleteMcp": "Delete this MCP server?",
		"prompt.sessionName": "Session name",
		"prompt.projectName": "Project name",
		"runtime.failed": "Runtime failed",
		"retry": "Retry",
		"streaming": "While streaming",
		"stream.steer": "Steer",
		"stream.follow": "Follow up",
		"queue.choose": "Select steer or follow up before sending",
		"context.rename": "Rename",
		"message.processing": "Processing...",
		"message.processed": "Processed",
		"settings.defaultThinking": "Default thinking level",
		"settings.fontSize": "Font size",
		"settings.conversationFontSize": "Conversation font",
		"settings.sidebarFontSize": "Sidebar font",
		"settings.fontSizeHint": "Adjust the conversation and the project, title, and history text in the sidebar.",
		"toast.fontSizeSaved": "Font sizes updated",
		"toast.themeSaved": "Theme updated",
	},
};

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const iconName = (value) => value.split("-").map((piece) => piece[0].toUpperCase() + piece.slice(1)).join("");
const t = (key) => translations[desktopState?.settings?.locale ?? "zh-CN"]?.[key] ?? translations.en[key] ?? key;

function hydrateIcons(root = document) {
	for (const target of root.querySelectorAll("[data-icon]")) {
		const node = icons[iconName(target.dataset.icon)] ?? icons.Circle;
		const svg = createElement(node, { width: 16, height: 16, "aria-hidden": "true", "stroke-width": 1.8 });
		if (target.classList.length > 0) svg.classList.add(...target.classList);
		target.replaceWith(svg);
	}
}

function showToast(message, tone = "info") {
	const toast = byId("toast");
	toast.textContent = message;
	toast.dataset.tone = tone;
	toast.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => toast.classList.add("hidden"), 4200);
}

async function command(commandValue) {
	const response = await fetch("/api/command", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ requestId: crypto.randomUUID(), command: commandValue }),
	});
	const result = await response.json();
	if (!result.success) throw new Error(result.error?.message ?? "Command failed");
	return result.data;
}

async function run(commandValue, successMessage) {
	try {
		const result = await command(commandValue);
		if (successMessage) showToast(successMessage);
		await refresh();
		return result;
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
}

function activeProject() {
	return desktopState?.projects.find((project) => project.id === desktopState.activeProjectId) ?? null;
}

function activeSession() {
	return desktopState?.conversations.find((session) => session.id === desktopState.activeSessionId) ?? null;
}

function renderProjectTree() {
	const container = byId("projects");
	if (desktopState.projects.length === 0) {
		container.innerHTML = `<button class="project-button" data-action="add-project"><span data-icon="folder-plus"></span><span class="project-name">${t("projects.add")}</span></button>`;
		hydrateIcons(container);
		return;
	}
	container.innerHTML = desktopState.projects.map((project) => {
		const active = project.id === desktopState.activeProjectId;
		const expanded = !collapsedProjects.has(project.id);
		const sessions = (active ? desktopState.conversations : sessionsByProject.get(project.id) ?? []).map((session) => `
			<button class="session-button ${session.id === desktopState.activeSessionId ? "active" : ""}" data-action="select-session" data-session-id="${escapeHtml(session.id)}" data-context-type="session" data-context-id="${escapeHtml(session.id)}">
				<span class="session-status ${escapeHtml(session.status)}"></span>
				<span class="session-name">${escapeHtml(session.title)}</span>
			</button>`).join("");
		return `<div class="project-item">
			<div class="project-row ${active ? "active" : ""}" data-context-type="project" data-context-id="${escapeHtml(project.id)}">
				<button class="tree-toggle" data-action="toggle-project" data-project-id="${escapeHtml(project.id)}" title="${t("history")}" aria-label="${t("history")}"><span data-icon="${expanded ? "chevron-down" : "chevron-right"}"></span></button>
				<button class="project-button" data-action="select-project" data-project-id="${escapeHtml(project.id)}">
				<span data-icon="folder"></span>
				<span class="project-name" title="${escapeHtml(project.rootPath)}">${escapeHtml(project.name)}</span>
				</button>
				<button class="project-new-session icon-button" data-action="new-session" data-project-id="${escapeHtml(project.id)}" title="${t("session.new")}" aria-label="${t("session.new")}"><span data-icon="message-square-plus"></span></button>
			</div>
			${expanded ? `<div class="session-list">${sessions || `<div class="session-empty">${t("history.empty")}</div>`}</div>` : ""}
		</div>`;
	}).join("");
	hydrateIcons(container);
}

function hideContextMenu() {
	const menu = byId("context-menu");
	menu.classList.add("hidden");
	menu.innerHTML = "";
	contextMenuTarget = null;
}

function showContextMenu(type, id, clientX, clientY) {
	const menu = byId("context-menu");
	contextMenuTarget = { type, id };
	menu.innerHTML = `<button type="button" role="menuitem" data-action="rename-context">${t("context.rename")}</button>`;
	menu.classList.remove("hidden");
	const maxX = window.innerWidth - menu.offsetWidth - 8;
	const maxY = window.innerHeight - menu.offsetHeight - 8;
	menu.style.left = `${Math.max(8, Math.min(clientX, maxX))}px`;
	menu.style.top = `${Math.max(8, Math.min(clientY, maxY))}px`;
}

function renderHeader() {
	const project = activeProject();
	const session = activeSession();
	byId("project-title").textContent = project?.name ?? t("project.none");
	byId("session-title").textContent = session?.title ?? t("session.new");
	const runtime = desktopState.runtime;
	const status = runtime?.status ?? "idle";
	byId("runtime-dot").className = `status-dot ${status}`;
	byId("runtime-mini-label").textContent = runtime ? status[0].toUpperCase() + status.slice(1) : t("runtime.none");
	const modelSelect = byId("model-select");
	const enabledModels = desktopState.models.filter((model) => model.enabled);
	modelSelect.innerHTML = `<option value="">${t("model")}</option>${enabledModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName)}</option>`).join("")}`;
	const currentModel = enabledModels.find((model) => model.providerId === runtime?.modelProvider && model.modelId === runtime?.modelId)
		?? enabledModels.find((model) => model.id === desktopState.settings.defaultModelProfileId);
	modelSelect.value = currentModel?.id ?? "";
	modelSelect.disabled = !runtime || runtime.isStreaming;
	byId("thinking-select").value = runtime?.thinkingLevel ?? desktopState.settings.defaultThinkingLevel ?? "high";
	byId("thinking-select").disabled = !runtime || runtime.isStreaming;
	for (const option of byId("thinking-select").options) option.textContent = t(`thinking.${option.value}`);
}

function renderTrustBanner() {
	const project = activeProject();
	const banner = byId("trust-banner");
	if (!project || project.trustState === "trusted") {
		banner.classList.add("hidden");
		return;
	}
	banner.classList.remove("hidden");
	banner.innerHTML = `<div><strong>${project.trustState === "unknown" ? t("trust.required") : t("trust.restricted")}</strong><div>${escapeHtml(project.rootPath)}</div></div><div class="banner-actions"><button class="text-button" data-action="set-trust" data-project-id="${escapeHtml(project.id)}" data-trust="untrusted">${t("trust.keep")}</button><button class="text-button primary" data-action="set-trust" data-project-id="${escapeHtml(project.id)}" data-trust="trusted">${t("trust.allow")}</button></div>`;
}

function messageText(message) {
	return message.parts.filter((part) => part.type === "text" || part.type === "error").map((part) => part.text).join("");
}

function formatDuration(durationMs) {
	if (!Number.isFinite(durationMs) || durationMs < 0) return "";
	const seconds = Math.max(0, Math.round(durationMs / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function applyFontSettings() {
	const settings = desktopState?.settings;
	const conversationFontSize = Number.isInteger(settings?.conversationFontSize) ? settings.conversationFontSize : 16;
	const sidebarFontSize = Number.isInteger(settings?.sidebarFontSize) ? settings.sidebarFontSize : 14;
	document.documentElement.style.setProperty("--conversation-font-size", `${Math.min(20, Math.max(14, conversationFontSize))}px`);
	document.documentElement.style.setProperty("--sidebar-font-size", `${Math.min(18, Math.max(12, sidebarFontSize))}px`);
}

function applyTheme() {
	const theme = desktopState?.settings?.theme === "light" ? "light" : "dark";
	document.documentElement.dataset.theme = theme;
	document.documentElement.style.colorScheme = theme;
}

function startDurationTicker() {
	if (durationTicker !== undefined) return;
	durationTicker = setInterval(() => {
		if (!desktopState?.runtime?.isStreaming) {
			clearInterval(durationTicker);
			durationTicker = undefined;
			return;
		}
		scheduleRender();
	}, 250);
}

function stopDurationTicker() {
	if (durationTicker === undefined) return;
	clearInterval(durationTicker);
	durationTicker = undefined;
}

function hasVisibleMessageContent(message) {
	return message.parts.some((part) => typeof part.text === "string" && part.text.trim().length > 0);
}

function mergePartText(current, incoming, separator = "\n\n") {
	if (!current) return incoming;
	if (!incoming || current === incoming || current.includes(incoming)) return current;
	if (incoming.includes(current)) return incoming;
	return `${current}${separator}${incoming}`;
}

function mergeRenderableParts(target, incoming) {
	const parts = target.parts.map((part) => ({ ...part }));
	for (const incomingPart of incoming.parts) {
		const existing = incomingPart.type === "tool"
			? parts.find((part) => part.type === "tool" && part.toolCallId !== undefined && part.toolCallId === incomingPart.toolCallId)
			: parts.find((part) => part.type === incomingPart.type);
		if (!existing) {
			parts.push({ ...incomingPart });
			continue;
		}
		if (existing.type === "tool" && incomingPart.type === "tool") {
			if (incomingPart.text.length >= existing.text.length) existing.text = incomingPart.text;
			if (incomingPart.toolName) existing.toolName = incomingPart.toolName;
			if (incomingPart.status) existing.status = incomingPart.status;
		} else existing.text = mergePartText(existing.text, incomingPart.text);
	}
	return parts;
}

function collapseAssistantMessages(messages) {
	const result = [];
	for (const message of messages) {
		if (message.role === "user" || message.role === "system") {
			result.push({ ...message, parts: message.parts.map((part) => ({ ...part })) });
			continue;
		}
		const previous = result.at(-1);
		if (message.role === "tool") {
			if (previous?.role === "assistant") previous.parts = mergeRenderableParts(previous, message);
			continue;
		}
		if (message.role !== "assistant") continue;
		if (previous?.role === "assistant") {
			previous.parts = mergeRenderableParts(previous, message);
			previous.status = message.status ?? previous.status;
			if (message.durationMs !== undefined) previous.durationMs = message.durationMs;
			const incomingDuration = responseDurations.get(message.id);
			if (incomingDuration !== undefined) {
				const currentDuration = responseDurations.get(previous.id) ?? 0;
				responseDurations.set(previous.id, Math.max(currentDuration, incomingDuration));
			}
			continue;
		}
		result.push({ ...message, parts: message.parts.map((part) => ({ ...part })) });
	}
	return result;
}

function renderMarkdown(value) {
	let html = escapeHtml(value);
	html = html.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_match, language, code) => `<pre><code class="language-${escapeHtml(language.trim())}">${code}</code></pre>`);
	html = html.replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h1>$1</h1>");
	html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
	html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
	return html.replace(/\n/g, "<br>");
}

function renderActivityPart(part) {
	if (part.type === "thinking") return `<div class="activity-entry thinking-entry">${renderMarkdown(part.text)}</div>`;
	if (part.type !== "tool") return "";
	const state = part.status === "failed" ? "failed" : part.status === "finished" ? "finished" : "running";
	return `<div class="activity-entry tool-entry ${state}"><span class="activity-label">${escapeHtml(part.toolName ?? t("message.tool"))}</span><div>${renderMarkdown(part.text)}</div></div>`;
}

function renderMessages() {
	const container = byId("messages");
	const shouldStickToBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 72;
	if (!desktopState.activeProjectId) {
		container.innerHTML = `<div class="conversation-column"><div class="empty-state"><h1>${t("project.none")}</h1><p>${t("projects.addHint")}</p><div class="form-actions"><button class="text-button primary" data-action="add-project"><span data-icon="folder-plus"></span> ${t("projects.add")}</button></div></div></div>`;
		hydrateIcons(container);
		return;
	}
	if (desktopState.messages.length === 0) {
		container.innerHTML = `<div class="conversation-column"><div class="empty-state"><h1>${t("session.new")}</h1><p>${t("message.empty")}</p></div></div>`;
		return;
	}
	const messageHtml = collapseAssistantMessages(desktopState.messages).map((message) => {
		const isUser = message.role === "user";
		const errorPart = message.parts.find((part) => part.type === "error");
		const content = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
		const activity = message.parts.filter((part) => part.type === "thinking" || part.type === "tool").map(renderActivityPart).join("");
		const open = reasoningOpen.get(message.id) ?? true;
		const duration = formatDuration(message.durationMs ?? responseDurations.get(message.id) ?? (responseStartedAt.has(message.id) ? performance.now() - responseStartedAt.get(message.id) : message.status === "streaming" ? Math.max(0, Date.now() - Date.parse(message.createdAt)) : message.role === "assistant" && message.status === "finished" ? 0 : NaN));
		if (isUser) {
			return `<article class="message user" data-message-id="${escapeHtml(message.id)}">
				${content ? `<div class="message-body markdown-body">${renderMarkdown(content)}</div>` : ""}
				<div class="message-meta"><button data-action="copy-message" data-message-id="${escapeHtml(message.id)}" title="${t("message.copy")}" aria-label="${t("message.copy")}"><span data-icon="copy"></span></button><time datetime="${escapeHtml(message.createdAt)}">${new Date(message.createdAt).toLocaleTimeString(desktopState.settings.locale, { hour: "2-digit", minute: "2-digit" })}</time></div>
			</article>`;
		}
		if (message.status === "error" || errorPart) {
			return `<article class="message assistant" data-message-id="${escapeHtml(message.id)}"><div class="message-error">${renderMarkdown(errorPart?.text ?? content)}</div></article>`;
		}
		if (!content && !activity && message.status !== "streaming") return "";
		const status = message.status === "streaming" ? t("message.processing") : t("message.processed");
		return `<article class="message assistant" data-message-id="${escapeHtml(message.id)}">
			<details class="message-activity" data-reasoning-id="${escapeHtml(message.id)}" ${open ? "open" : ""}><summary><span class="activity-toggle" data-icon="chevron-right"></span><span class="activity-status">${escapeHtml(status)}</span>${duration ? `<time class="activity-duration" datetime="${escapeHtml(message.createdAt)}">${escapeHtml(duration)}</time>` : ""}</summary>${activity ? `<blockquote>${activity}</blockquote>` : ""}</details>
			${content ? `<div class="message-body markdown-body">${renderMarkdown(content)}</div><div class="message-meta assistant-meta"><button data-action="copy-message" data-message-id="${escapeHtml(message.id)}" title="${t("message.copy")}" aria-label="${t("message.copy")}"><span data-icon="copy"></span></button><time datetime="${escapeHtml(message.createdAt)}">${new Date(message.createdAt).toLocaleTimeString(desktopState.settings.locale, { hour: "2-digit", minute: "2-digit" })}</time></div>` : ""}
		</article>`;
	}).filter(Boolean).join("");
	container.innerHTML = `<div class="conversation-column">${messageHtml}</div>`;
	hydrateIcons(container);
	if (shouldStickToBottom) container.scrollTop = container.scrollHeight;
}

function renderComposer() {
	const runtime = desktopState.runtime;
	const streaming = runtime?.isStreaming === true;
	byId("prompt-input").disabled = !runtime || runtime.status === "starting";
	byId("queue-controls").classList.toggle("hidden", !streaming);
	byId("prompt-form").querySelector(".send-button").classList.toggle("hidden", !runtime);
	byId("prompt-form").querySelector(".stop-button").classList.toggle("hidden", !streaming);
	for (const button of byId("queue-controls").querySelectorAll("[data-queue]")) button.classList.toggle("selected", button.dataset.queue === selectedQueue);
	const errorRow = byId("error-row");
	if (runtime?.status === "error") {
		errorRow.classList.remove("hidden");
		errorRow.innerHTML = `${escapeHtml(runtime.lastError ?? t("runtime.failed"))} <button class="text-button" data-action="retry-last">${t("retry")}</button>`;
	} else {
		errorRow.classList.add("hidden");
	}
	renderSlashMenu();
}

function updateSlashItems() {
	const text = byId("prompt-input").value;
	if (!text.startsWith("/") || text.includes("\n")) {
		slashItems = [];
		slashIndex = 0;
		return;
	}
	const query = text.slice(1).toLowerCase();
	slashItems = desktopState.commands.filter((commandInfo) => commandInfo.name.toLowerCase().includes(query)).slice(0, 8);
	if (slashIndex >= slashItems.length) slashIndex = 0;
}

function renderSlashMenu() {
	updateSlashItems();
	const menu = byId("slash-menu");
	if (slashItems.length === 0) {
		menu.classList.add("hidden");
		return;
	}
	menu.classList.remove("hidden");
	menu.innerHTML = slashItems.map((commandInfo, index) => `<div class="slash-item ${index === slashIndex ? "selected" : ""}" data-action="select-command" data-command="${escapeHtml(commandInfo.name)}"><strong>/${escapeHtml(commandInfo.name)}</strong><span>${escapeHtml(commandInfo.description ?? commandInfo.source)}${commandInfo.scope ? ` / ${escapeHtml(commandInfo.scope)}` : ""}</span></div>`).join("");
}

function renderSettings() {
	for (const tab of document.querySelectorAll("[data-settings-tab]")) tab.classList.toggle("active", tab.dataset.settingsTab === settingsTab);
	byId("settings-section-title").textContent = t(`settings.${settingsTab}`);
	const content = byId("settings-content");
	if (settingsTab === "models") renderModelsSettings(content);
	else if (settingsTab === "general") renderGeneralSettings(content);
	else if (settingsTab === "skills") renderSkillsSettings(content);
	else if (settingsTab === "mcp") renderMcpSettings(content);
	else renderDiagnosticsSettings(content);
	hydrateIcons(content);
}

function renderModelsSettings(content) {
	const editing = desktopState.models.find((model) => model.id === editingModelId);
	const enabledModels = desktopState.models.filter((model) => model.enabled);
	content.innerHTML = `<section class="settings-section"><h2>${t("settings.models")}</h2><p>${desktopState.models.length} ${t("settings.configured")}</p>
		<div class="settings-card"><h3>${editing ? t("settings.editModel") : t("settings.addModel")}</h3><form id="model-form" class="form-grid">
			<label class="form-field"><span>${t("settings.name")}</span><input name="displayName" required value="${escapeHtml(editing?.displayName ?? "")}"></label>
			<label class="form-field"><span>${t("settings.providerId")}</span><input name="providerId" required value="${escapeHtml(editing?.providerId ?? "openai-compatible")}"></label>
			<label class="form-field full"><span>${t("settings.baseUrl")}</span><input name="baseUrl" type="url" required placeholder="http://localhost:11434/v1" value="${escapeHtml(editing?.baseUrl ?? "")}"></label>
			<label class="form-field"><span>${t("settings.modelId")}</span><input name="modelId" required value="${escapeHtml(editing?.modelId ?? "")}"></label>
			<label class="form-field"><span>${t("settings.apiKey")}</span><input name="apiKey" type="password" autocomplete="new-password" placeholder="${editing?.credentialRef ? t("settings.apiKeyStored") : ""}"></label>
			<label class="form-field"><span><input name="enabled" type="checkbox" ${editing?.enabled === false ? "" : "checked"}> ${t("settings.enabled")}</span></label>
			<div class="form-actions full">${editing ? `<button type="button" class="text-button" data-action="cancel-model-edit">${t("settings.cancel")}</button>` : ""}<button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div>
		</form></div>
		<div class="settings-card"><h3>${t("settings.defaultModel")}</h3><form id="default-model-form"><label class="form-field"><select name="defaultModelProfileId" ${enabledModels.length === 0 ? "disabled" : ""}><option value="">${enabledModels.length === 0 ? t("settings.noModels") : t("settings.defaultModel")}</option>${enabledModels.map((model) => `<option value="${escapeHtml(model.id)}" ${desktopState.settings.defaultModelProfileId === model.id ? "selected" : ""}>${escapeHtml(model.displayName)}</option>`).join("")}</select></label><div class="form-actions"><button class="text-button primary" type="submit" ${enabledModels.length === 0 ? "disabled" : ""}><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
		<div class="settings-card"><h3>${t("settings.profiles")}</h3>${desktopState.models.length === 0 ? `<div class="muted">${t("settings.noModels")}</div>` : desktopState.models.map((model) => `<div class="model-row"><div class="model-info"><strong>${escapeHtml(model.displayName)}${model.enabled ? "" : ` / ${t("settings.disabled")}`}</strong><span>${escapeHtml(model.providerId)}/${escapeHtml(model.modelId)} / ${escapeHtml(model.baseUrl)}${model.credentialRef ? ` / ${t("settings.apiKeyStored")}` : ""}</span></div><div class="model-actions"><button class="icon-button" data-action="default-model" data-profile-id="${escapeHtml(model.id)}" title="${t("settings.default")}" aria-label="${t("settings.default")}"><span data-icon="star"></span></button><button class="icon-button" data-action="test-model" data-profile-id="${escapeHtml(model.id)}" title="${t("settings.test")}" aria-label="${t("settings.test")}"><span data-icon="plug-zap"></span></button><button class="icon-button" data-action="edit-model" data-profile-id="${escapeHtml(model.id)}" title="${t("settings.editModel")}" aria-label="${t("settings.editModel")}"><span data-icon="pencil"></span></button><button class="icon-button" data-action="delete-model" data-profile-id="${escapeHtml(model.id)}" title="${t("settings.delete")}" aria-label="${t("settings.delete")}"><span data-icon="trash-2"></span></button></div></div>`).join("")}</div>
	</section>`;
}

function renderGeneralSettings(content) {
	const webSearch = desktopState.settings.webSearch;
	content.innerHTML = `<section class="settings-section"><h2>${t("settings.general")}</h2>
		<div class="settings-card"><h3>${t("settings.language")}</h3><form id="locale-form"><label class="form-field"><select name="locale"><option value="zh-CN" ${desktopState.settings.locale === "zh-CN" ? "selected" : ""}>中文</option><option value="en" ${desktopState.settings.locale === "en" ? "selected" : ""}>English</option></select></label><div class="form-actions"><button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
		<div class="settings-card"><h3>${t("settings.theme")}</h3><p>${t("settings.themeHint")}</p><div class="theme-switch" role="group" aria-label="${escapeHtml(t("settings.theme"))}"><button type="button" class="theme-option ${desktopState.settings.theme === "light" ? "active" : ""}" data-action="change-theme" data-theme="light" aria-pressed="${desktopState.settings.theme === "light"}"><span data-icon="sun"></span><span>${t("theme.light")}</span></button><button type="button" class="theme-option ${desktopState.settings.theme === "dark" ? "active" : ""}" data-action="change-theme" data-theme="dark" aria-pressed="${desktopState.settings.theme === "dark"}"><span data-icon="moon"></span><span>${t("theme.dark")}</span></button></div></div>
		<div class="settings-card"><h3>${t("settings.fontSize")}</h3><p>${t("settings.fontSizeHint")}</p><form id="font-size-form" class="font-size-form"><label class="range-field"><span>${t("settings.conversationFontSize")} <output id="conversation-font-size-value" for="conversation-font-size">${desktopState.settings.conversationFontSize}px</output></span><input id="conversation-font-size" name="conversationFontSize" type="range" min="14" max="20" step="1" value="${desktopState.settings.conversationFontSize}"></label><label class="range-field"><span>${t("settings.sidebarFontSize")} <output id="sidebar-font-size-value" for="sidebar-font-size">${desktopState.settings.sidebarFontSize}px</output></span><input id="sidebar-font-size" name="sidebarFontSize" type="range" min="12" max="18" step="1" value="${desktopState.settings.sidebarFontSize}"></label><div class="form-actions"><button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
		<div class="settings-card"><h3>${t("settings.defaultThinking")}</h3><form id="default-thinking-form"><label class="form-field"><select name="defaultThinkingLevel">${["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => `<option value="${level}" ${desktopState.settings.defaultThinkingLevel === level ? "selected" : ""}>${t(`thinking.${level}`)}</option>`).join("")}</select></label><div class="form-actions"><button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
		<div class="settings-card"><h3>${t("settings.globalPrompt")}</h3><form id="global-prompt-form"><label class="form-field"><textarea name="globalSystemPrompt">${escapeHtml(desktopState.settings.globalSystemPrompt)}</textarea></label><div class="form-actions"><button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
		<div class="settings-card"><h3>${t("settings.shortcut")}</h3><form id="shortcut-form" class="form-grid"><label class="form-field full"><input name="invokeShortcut" data-shortcut-recorder value="${escapeHtml(desktopState.settings.invokeShortcut)}"></label><div class="form-actions full"><button class="text-button" type="button" data-action="reset-shortcut"><span data-icon="rotate-ccw"></span> ${t("settings.reset")}</button><button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
		<div class="settings-card"><h3>${t("settings.webSearch")}</h3><form id="web-search-form" class="form-grid"><label class="form-field"><span>${t("settings.provider")}</span><select name="provider"><option value="disabled" ${webSearch.provider === "disabled" ? "selected" : ""}>${t("settings.disabled")}</option><option value="brave" ${webSearch.provider === "brave" ? "selected" : ""}>Brave Search</option><option value="tavily" ${webSearch.provider === "tavily" ? "selected" : ""}>Tavily</option></select></label><label class="form-field"><span>${t("settings.apiKey")}</span><input name="apiKey" type="password" autocomplete="new-password" placeholder="${webSearch.credentialRef ? t("settings.apiKeyStored") : ""}"></label><label class="form-field full"><span><input name="clearCredential" type="checkbox"> ${t("settings.clearKey")}</span></label><div class="form-actions full"><button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
		<div class="settings-card"><h3>${t("settings.window")}</h3><form id="window-behavior-form"><label class="form-field"><span><input name="closeToTray" type="checkbox" ${desktopState.settings.closeToTray ? "checked" : ""}> ${t("settings.closeToTray")}</span></label><div class="form-actions"><button class="text-button primary" type="submit"><span data-icon="save"></span> ${t("settings.save")}</button></div></form></div>
	</section>`;
}

function renderSkillsSettings(content) {
	const skills = desktopState.commands.filter((commandInfo) => commandInfo.source === "skill");
	content.innerHTML = `<section class="settings-section"><h2>${t("settings.skills")}</h2><p>${skills.length} ${t("settings.configured")}</p>
		<div class="settings-card"><h3>${t("settings.directories")}</h3><form id="skill-directory-form" class="form-grid"><label class="form-field full"><input name="directory" required placeholder="SKILL.md"></label><div class="form-actions full"><button class="text-button primary" type="submit"><span data-icon="plus"></span> ${t("settings.add")}</button></div></form>${desktopState.settings.skillDirectories.map((directory) => `<div class="directory-row"><span title="${escapeHtml(directory)}">${escapeHtml(directory)}</span><button class="icon-button" data-action="remove-skill-directory" data-directory="${escapeHtml(directory)}" title="${t("settings.delete")}" aria-label="${t("settings.delete")}"><span data-icon="x"></span></button></div>`).join("")}<div class="form-actions"><button class="text-button" data-action="reload-skills"><span data-icon="refresh-cw"></span> ${t("settings.rescan")}</button></div></div>
		<div class="settings-card"><h3>${t("settings.loadedCommands")}</h3>${skills.length === 0 ? `<div class="muted">${t("settings.noSkills")}</div>` : skills.map((skill) => `<div class="directory-row"><span><strong>/${escapeHtml(skill.name)}</strong><br><span class="muted">${escapeHtml(skill.description ?? "")}</span></span><span class="trust-pill ${escapeHtml(skill.scope ?? "temporary")}">${escapeHtml(skill.scope ?? "temporary")}</span></div>`).join("")}</div>
	</section>`;
}

function renderMcpSettings(content) {
	const servers = desktopState.mcpServers ?? [];
	content.innerHTML = `<section class="settings-section"><h2>${t("settings.mcp")}</h2><p>${servers.length} ${t("settings.configured")}</p>
		<div class="settings-card"><h3>${t("settings.addServer")}</h3><form id="mcp-form" class="form-grid">
			<label class="form-field"><span>${t("settings.name")}</span><input name="name" required placeholder="Filesystem"></label>
			<label class="form-field"><span>${t("settings.namespace")}</span><input name="namespace" required pattern="[A-Za-z][A-Za-z0-9_-]*" placeholder="filesystem"></label>
			<label class="form-field"><span>${t("settings.transport")}</span><select name="transport"><option value="stdio">STDIO</option><option value="http">HTTP</option></select></label>
			<label class="form-field"><span>${t("settings.command")}</span><input name="command" placeholder="npx"></label>
			<label class="form-field full"><span>${t("settings.arguments")}</span><textarea name="args" rows="2" placeholder="-y\n@modelcontextprotocol/server-filesystem"></textarea></label>
			<label class="form-field full"><span>${t("settings.httpUrl")}</span><input name="url" type="url" placeholder="https://localhost:3000/mcp"></label>
			<label class="form-field"><span><input name="enabled" type="checkbox" checked> ${t("settings.enabled")}</span></label>
			<div class="form-actions full"><button class="text-button primary" type="submit"><span data-icon="plus"></span>${t("settings.addServer")}</button></div>
		</form></div>
		<div class="settings-card"><h3>${t("settings.profiles")}</h3>${servers.length === 0 ? `<div class="muted">${t("settings.noMcp")}</div>` : servers.map((server) => `<div class="model-row"><div class="model-info"><strong>${escapeHtml(server.profile.name)} / ${escapeHtml(server.status)}</strong><span>${escapeHtml(server.profile.transport)} / ${escapeHtml(server.profile.namespace)} / ${server.toolCount} tools${server.lastError ? ` / ${escapeHtml(server.lastError)}` : ""}</span></div><div class="model-actions"><button class="icon-button" data-action="toggle-mcp" data-server-id="${escapeHtml(server.profile.id)}" title="${t("settings.enabled")}" aria-label="${t("settings.enabled")}"><span data-icon="${server.profile.enabled ? "pause" : "play"}"></span></button><button class="icon-button" data-action="test-mcp" data-server-id="${escapeHtml(server.profile.id)}" title="${t("settings.test")}" aria-label="${t("settings.test")}"><span data-icon="plug-zap"></span></button><button class="icon-button" data-action="delete-mcp" data-server-id="${escapeHtml(server.profile.id)}" title="${t("settings.delete")}" aria-label="${t("settings.delete")}"><span data-icon="trash-2"></span></button></div></div>`).join("")}</div>
	</section>`;
}

function renderDiagnosticsSettings(content) {
	const diagnostics = [...desktopState.diagnostics].reverse();
	content.innerHTML = `<section class="settings-section"><h2>${t("settings.diagnostics")}</h2><p>${diagnostics.length} ${t("settings.recentEvents")}</p><div class="settings-card"><h3>${t("settings.runtime")}</h3><div class="directory-row"><span>${t("settings.status")}</span><strong>${escapeHtml(desktopState.runtime?.status ?? "stopped")}</strong></div><div class="directory-row"><span>Runtime ID</span><strong>${escapeHtml(desktopState.runtime?.runtimeId ?? "-")}</strong></div><div class="directory-row"><span>${t("settings.sessionFile")}</span><strong title="${escapeHtml(desktopState.runtime?.sessionPath ?? "")}">${escapeHtml(desktopState.runtime?.sessionPath ?? "-")}</strong></div><div class="form-actions"><button class="text-button" data-action="export-diagnostics"><span data-icon="download"></span>${t("settings.export")}</button></div></div><div class="settings-card"><h3>${t("settings.recentEvents")}</h3>${diagnostics.length === 0 ? `<div class="muted">${t("settings.noDiagnostics")}</div>` : diagnostics.map((diagnostic) => `<div class="diagnostic-row"><strong>${escapeHtml(diagnostic.level)} / ${escapeHtml(diagnostic.component)}</strong><span>${escapeHtml(diagnostic.message)}</span></div>`).join("")}</div></section>`;
}

function render() {
	applyTheme();
	applyFontSettings();
	document.documentElement.lang = desktopState.settings.locale;
	document.title = t("app.title");
	for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = t(element.dataset.i18n);
	for (const element of document.querySelectorAll("[data-i18n-title]")) {
		element.title = t(element.dataset.i18nTitle);
		element.setAttribute("aria-label", t(element.dataset.i18nTitle));
	}
	byId("prompt-input").placeholder = t("prompt.placeholder");
	byId("composer-hint").textContent = t("prompt.hint");
	renderProjectTree();
	renderHeader();
	renderTrustBanner();
	renderMessages();
	renderComposer();
	byId("chat-view").classList.toggle("hidden", settingsOpen);
	byId("settings-view").classList.toggle("hidden", !settingsOpen);
	if (settingsOpen) renderSettings();
}

async function refreshProjectSessions() {
	const entries = await Promise.all(desktopState.projects.map(async (project) => {
		if (project.id === desktopState.activeProjectId) return [project.id, desktopState.conversations];
		try {
			return [project.id, await command({ type: "sessions.list", projectId: project.id })];
		} catch {
			return [project.id, []];
		}
	}));
	sessionsByProject = new Map(entries);
}

async function refresh(includeProjectSessions = true) {
	try {
		const previousSessionId = desktopState?.activeSessionId;
		desktopState = await (await fetch("/api/state", { cache: "no-store" })).json();
		if (previousSessionId && previousSessionId !== desktopState.activeSessionId) {
			responseStartedAt.clear();
			responseDurations.clear();
		}
		if (includeProjectSessions) await refreshProjectSessions();
		render();
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error), "error");
	}
}

function scheduleRefresh(includeProjectSessions = false) {
	clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => void refresh(includeProjectSessions), 40);
}

function scheduleRender() {
	if (renderFrame !== undefined) return;
	renderFrame = requestAnimationFrame(() => {
		renderFrame = undefined;
		if (!desktopState || settingsOpen) return;
		renderHeader();
		renderMessages();
		renderComposer();
	});
}

function eventBelongsToActiveRuntime(event) {
	const runtime = desktopState?.runtime;
	if (event.type?.startsWith("mcp.")) return true;
	return !runtime || (event.runtimeId === runtime.runtimeId && event.sessionId === runtime.sessionId);
}

function applyDesktopEvent(event) {
	if (!desktopState || !event || !event.type || !eventBelongsToActiveRuntime(event)) return false;
	if (event.type === "mcp.consentRequired") {
		const request = event.request;
		if (request) {
			const approved = window.confirm(`Allow MCP tool ${request.serverId}.${request.toolName} for this project?`);
			void run({ type: "mcp.consent.respond", requestId: request.requestId, approved, scope: "once" });
		}
		return true;
	}
	if (event.type === "mcp.consentResolved") {
		if (desktopState.consentRequests) desktopState.consentRequests = desktopState.consentRequests.filter((request) => request.requestId !== event.requestId);
		return true;
	}
	if (event.type === "mcp.serverChanged" || event.type === "mcp.toolsChanged") {
		scheduleRefresh(false);
		return true;
	}
	if (event.type === "message.started") {
		const message = { ...event.message, parts: event.message.parts.map((part) => ({ ...part })) };
		const existingIndex = desktopState.messages.findIndex((candidate) => candidate.id === message.id);
		if (existingIndex >= 0) desktopState.messages[existingIndex] = message;
		else desktopState.messages.push(message);
		if (message.role === "assistant") {
			responseStartedAt.set(message.id, performance.now());
			responseDurations.delete(message.id);
			if (!reasoningOpen.has(message.id)) reasoningOpen.set(message.id, true);
			startDurationTicker();
		}
		if (desktopState.runtime) {
			desktopState.runtime.status = "streaming";
			desktopState.runtime.isStreaming = true;
		}
		scheduleRender();
		return true;
	}
	if (event.type === "message.delta") {
		const message = desktopState.messages.find((candidate) => candidate.id === event.messageId) ?? [...desktopState.messages].reverse().find((candidate) => candidate.role === "assistant" && candidate.status === "streaming");
		if (!message) {
			scheduleRefresh(false);
			return true;
		}
		const part = message.parts.find((candidate) => candidate.type === event.part);
		if (part) part.text += event.delta;
		else message.parts.push({ type: event.part, text: event.delta });
		message.status = "streaming";
		if (desktopState.runtime) {
			desktopState.runtime.status = "streaming";
			desktopState.runtime.isStreaming = true;
		}
		scheduleRender();
		return true;
	}
	if (event.type === "message.finished") {
		const existing = desktopState.messages.find((candidate) => candidate.id === event.message.id) ?? [...desktopState.messages].reverse().find((candidate) => candidate.role === "assistant" && candidate.status === "streaming");
		const message = { ...event.message, id: existing?.id ?? event.message.id, parts: event.message.parts.map((part) => ({ ...part })) };
		if (existing && !hasVisibleMessageContent(message) && hasVisibleMessageContent(existing)) message.parts = existing.parts.map((part) => ({ ...part }));
		const startedAt = responseStartedAt.get(event.message.id) ?? (existing ? responseStartedAt.get(existing.id) : undefined);
		if (startedAt !== undefined) responseDurations.set(message.id, performance.now() - startedAt);
		responseStartedAt.delete(event.message.id);
		if (existing && existing.id !== message.id) responseStartedAt.delete(existing.id);
		const existingIndex = desktopState.messages.findIndex((candidate) => candidate.id === message.id);
		if (existingIndex >= 0) desktopState.messages[existingIndex] = message;
		else desktopState.messages.push(message);
		if (!desktopState.runtime?.isStreaming) stopDurationTicker();
		scheduleRender();
		return true;
	}
	if (event.type === "message.aborted") {
		const message = event.messageId ? desktopState.messages.find((candidate) => candidate.id === event.messageId) : undefined;
		if (message) message.status = "aborted";
		if (desktopState.runtime) {
			desktopState.runtime.status = "ready";
			desktopState.runtime.isStreaming = false;
		}
		stopDurationTicker();
		scheduleRender();
		return true;
	}
	if (event.type === "runtime.ready") {
		desktopState.runtime = { ...event.snapshot };
		if (!desktopState.runtime.isStreaming) {
			for (const message of desktopState.messages) {
				if (message.role === "assistant" && message.status === "streaming") message.status = "finished";
			}
			stopDurationTicker();
		}
		scheduleRender();
		return true;
	}
	if (event.type === "runtime.error") {
		if (desktopState.runtime) {
			desktopState.runtime.status = "error";
			desktopState.runtime.isStreaming = false;
			desktopState.runtime.lastError = event.error;
		}
		scheduleRender();
		return true;
	}
	if (event.type === "session.changed") {
		responseStartedAt.clear();
		responseDurations.clear();
		stopDurationTicker();
		scheduleRefresh(true);
		return true;
	}
	if (event.type === "tool.started" || event.type === "tool.update" || event.type === "tool.finished") {
		const message = desktopState.messages.find((candidate) => candidate.id === event.messageId);
		if (message) {
			message.status = "streaming";
			const existing = message.parts.find((part) => part.type === "tool" && part.toolCallId === event.toolCallId);
			if (existing && existing.type === "tool") {
				if (event.type !== "tool.started") existing.text = event.text;
				existing.status = event.type === "tool.finished" ? (event.failed ? "failed" : "finished") : event.type === "tool.update" ? "updated" : "started";
			} else {
				message.parts.push({ type: "tool", text: event.type === "tool.started" ? "" : event.text, toolName: event.toolName, toolCallId: event.toolCallId, status: event.type === "tool.finished" ? (event.failed ? "failed" : "finished") : event.type === "tool.update" ? "updated" : "started" });
			}
			scheduleRender();
		} else scheduleRefresh(false);
		return true;
	}
	if (event.type === "diagnostic") {
		scheduleRefresh(false);
		return true;
	}
	return false;
}

function startEventStream() {
	eventSource?.close();
	eventSource = new EventSource("/api/events");
	eventSource.addEventListener("desktop", (event) => {
		try {
			if (!applyDesktopEvent(JSON.parse(event.data))) scheduleRefresh(false);
		} catch {
			scheduleRefresh(false);
		}
	});
	eventSource.onerror = () => {
		clearInterval(fallbackRefreshTimer);
		fallbackRefreshTimer = setInterval(() => void refresh(true), 15_000);
	};
	eventSource.onopen = () => clearInterval(fallbackRefreshTimer);
}

function selectSlashCommand(commandName) {
	const input = byId("prompt-input");
	input.value = `/${commandName} `;
	slashItems = [];
	renderSlashMenu();
	input.focus();
}

const promptResizeLimits = { min: 64, max: 230 };
let promptResizeSession = null;

function setPromptHeight(height) {
	const input = byId("prompt-input");
	const nextHeight = Math.max(promptResizeLimits.min, Math.min(promptResizeLimits.max, height));
	input.style.height = `${nextHeight}px`;
}

function endPromptResize(event) {
	if (!promptResizeSession || (event && event.pointerId !== promptResizeSession.pointerId)) return;
	const handle = byId("prompt-form").querySelector("[data-resize-handle]");
	if (event && handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
	promptResizeSession = null;
}

const promptResizeHandle = byId("prompt-form").querySelector("[data-resize-handle]");
promptResizeHandle.addEventListener("pointerdown", (event) => {
	event.preventDefault();
	promptResizeSession = { pointerId: event.pointerId, startY: event.clientY, startHeight: byId("prompt-input").getBoundingClientRect().height };
	promptResizeHandle.setPointerCapture(event.pointerId);
});
promptResizeHandle.addEventListener("pointermove", (event) => {
	if (!promptResizeSession || event.pointerId !== promptResizeSession.pointerId) return;
	// The composer is anchored to the bottom, so dragging upward should make it taller.
	setPromptHeight(promptResizeSession.startHeight - (event.clientY - promptResizeSession.startY));
});
promptResizeHandle.addEventListener("pointerup", endPromptResize);
promptResizeHandle.addEventListener("pointercancel", endPromptResize);
promptResizeHandle.addEventListener("lostpointercapture", () => { promptResizeSession = null; });
promptResizeHandle.addEventListener("keydown", (event) => {
	if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
	event.preventDefault();
	const input = byId("prompt-input");
	setPromptHeight(input.getBoundingClientRect().height + (event.key === "ArrowUp" ? 16 : -16));
});

document.addEventListener("click", async (event) => {
	const actionTarget = event.target.closest("[data-action]");
	if (!actionTarget) return;
	event.preventDefault();
	const action = actionTarget.dataset.action;
	if (action === "add-project") await run({ type: "projects.addFromFolder" });
	else if (action === "select-project") await run({ type: "projects.select", projectId: actionTarget.dataset.projectId });
	else if (action === "toggle-project") {
		const projectId = actionTarget.dataset.projectId;
		if (collapsedProjects.has(projectId)) collapsedProjects.delete(projectId);
		else collapsedProjects.add(projectId);
		renderProjectTree();
	}
	else if (action === "new-session") await run({ type: "sessions.create", projectId: actionTarget.dataset.projectId });
	else if (action === "select-session") await run({ type: "sessions.open", sessionId: actionTarget.dataset.sessionId });
	else if (action === "rename-context") {
		const target = contextMenuTarget;
		hideContextMenu();
		if (target?.type === "session") {
			const session = desktopState.conversations.find((candidate) => candidate.id === target.id);
			const title = window.prompt(t("prompt.sessionName"), session?.title ?? "");
			if (title) await run({ type: "sessions.rename", sessionId: target.id, title });
		} else if (target?.type === "project") {
			const project = desktopState.projects.find((candidate) => candidate.id === target.id);
			const name = window.prompt(t("prompt.projectName"), project?.name ?? "");
			if (name) await run({ type: "projects.rename", projectId: target.id, name });
		}
	} else if (action === "set-trust") await run({ type: "projects.setTrust", projectId: actionTarget.dataset.projectId, trustState: actionTarget.dataset.trust });
	else if (action === "open-settings") { settingsOpen = true; render(); }
	else if (action === "change-theme") await run({ type: "settings.update", patch: { theme: actionTarget.dataset.theme } }, t("toast.themeSaved"));
	else if (action === "close-settings") { settingsOpen = false; editingModelId = null; render(); }
	else if (action === "abort") await run({ type: "agent.abort" });
	else if (action === "retry-last") await run({ type: "agent.retryLast" });
	else if (action === "clear-prompt") { byId("prompt-input").value = ""; renderSlashMenu(); byId("prompt-input").focus(); }
	else if (action === "copy-message") {
		const message = desktopState.messages.find((candidate) => candidate.id === actionTarget.dataset.messageId);
		if (message) { await navigator.clipboard.writeText(messageText(message)); showToast(t("toast.copied")); }
	} else if (action === "select-command") selectSlashCommand(actionTarget.dataset.command);
	else if (action === "edit-model") { editingModelId = actionTarget.dataset.profileId; settingsTab = "models"; renderSettings(); }
	else if (action === "cancel-model-edit") { editingModelId = null; renderSettings(); }
	else if (action === "delete-model") { if (window.confirm(t("confirm.deleteModel"))) await run({ type: "models.delete", profileId: actionTarget.dataset.profileId }, t("toast.modelDeleted")); }
	else if (action === "test-model") {
		const result = await run({ type: "models.testConnection", profileId: actionTarget.dataset.profileId });
		if (result) showToast(`${result.message} / ${result.latencyMs} ms`, result.ok ? "info" : "error");
	} else if (action === "default-model") await run({ type: "models.setDefault", profileId: actionTarget.dataset.profileId }, t("toast.defaultModel"));
	else if (action === "remove-skill-directory") await run({ type: "settings.update", patch: { skillDirectories: desktopState.settings.skillDirectories.filter((directory) => directory !== actionTarget.dataset.directory) } }, t("toast.skillRemoved"));
	else if (action === "reload-skills") await run({ type: "skills.reload" }, t("toast.skillsRescanned"));
	else if (action === "toggle-mcp") {
		const server = (desktopState.mcpServers ?? []).find((candidate) => candidate.profile.id === actionTarget.dataset.serverId);
		if (server) await run({ type: "mcp.setEnabled", serverId: server.profile.id, enabled: !server.profile.enabled }, t("toast.mcpUpdated"));
	} else if (action === "test-mcp") {
		const result = await run({ type: "mcp.testConnection", serverId: actionTarget.dataset.serverId });
		if (result) showToast(result.status === "ready" ? t("toast.mcpConnected") : (result.lastError ?? t("toast.mcpFailed")), result.status === "ready" ? "info" : "error");
	} else if (action === "delete-mcp") {
		if (window.confirm(t("confirm.deleteMcp"))) await run({ type: "mcp.delete", serverId: actionTarget.dataset.serverId }, t("toast.mcpDeleted"));
	}
	else if (action === "reset-shortcut") await run({ type: "settings.reset", key: "invokeShortcut" }, t("toast.saved"));
	else if (action === "export-diagnostics") {
		const path = await run({ type: "app.exportDiagnostics" });
		if (path) showToast(`Diagnostics exported to ${path}`);
	}
});

document.addEventListener("contextmenu", (event) => {
		const target = event.target.closest("[data-context-type]");
		if (!target) return;
		event.preventDefault();
		showContextMenu(target.dataset.contextType, target.dataset.contextId, event.clientX, event.clientY);
});

document.addEventListener("click", (event) => {
	if (!event.target.closest("#context-menu")) hideContextMenu();
});

document.addEventListener("click", (event) => {
	const queueButton = event.target.closest("[data-queue]");
	if (queueButton) { selectedQueue = queueButton.dataset.queue; renderComposer(); }
	const tab = event.target.closest("[data-settings-tab]");
	if (tab) { settingsTab = tab.dataset.settingsTab; editingModelId = null; renderSettings(); }
});

document.addEventListener("submit", async (event) => {
	if (event.target.id === "prompt-form") {
		event.preventDefault();
		const input = byId("prompt-input");
		const text = input.value.trim();
		if (!text) return;
		const streaming = desktopState.runtime?.isStreaming === true;
		if (streaming && !selectedQueue) { showToast(t("queue.choose"), "error"); return; }
		const result = await run({ type: "agent.prompt", text, queueMode: streaming ? selectedQueue : "prompt" });
		if (result !== undefined) { input.value = ""; selectedQueue = null; renderSlashMenu(); }
	} else if (event.target.id === "model-form") {
		event.preventDefault();
		const data = new FormData(event.target);
		const profile = { displayName: data.get("displayName"), providerId: data.get("providerId"), baseUrl: data.get("baseUrl"), modelId: data.get("modelId"), enabled: data.get("enabled") === "on" };
		const apiKey = data.get("apiKey") || undefined;
		const commandValue = editingModelId ? { type: "models.update", profileId: editingModelId, patch: profile, apiKey } : { type: "models.create", profile, apiKey };
		const result = await run(commandValue, t("toast.modelSaved"));
		if (result) { editingModelId = null; renderSettings(); }
	} else if (event.target.id === "global-prompt-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { globalSystemPrompt: new FormData(event.target).get("globalSystemPrompt") } }, t("toast.saved"));
	} else if (event.target.id === "shortcut-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { invokeShortcut: new FormData(event.target).get("invokeShortcut") } }, t("toast.saved"));
	} else if (event.target.id === "locale-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { locale: new FormData(event.target).get("locale") } }, t("toast.saved"));
	} else if (event.target.id === "default-model-form") {
		event.preventDefault();
		const profileId = new FormData(event.target).get("defaultModelProfileId");
		await run({ type: "models.setDefault", profileId: profileId || null }, t("toast.defaultModel"));
	} else if (event.target.id === "default-thinking-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { defaultThinkingLevel: new FormData(event.target).get("defaultThinkingLevel") } }, t("toast.saved"));
	} else if (event.target.id === "font-size-form") {
		event.preventDefault();
		const data = new FormData(event.target);
		await run({
			type: "settings.update",
			patch: {
				conversationFontSize: Number(data.get("conversationFontSize")),
				sidebarFontSize: Number(data.get("sidebarFontSize")),
			},
		}, t("toast.fontSizeSaved"));
	} else if (event.target.id === "web-search-form") {
		event.preventDefault();
		const data = new FormData(event.target);
		await run({ type: "webSearch.update", provider: data.get("provider"), apiKey: data.get("apiKey") || undefined, clearCredential: data.get("clearCredential") === "on" }, t("toast.saved"));
	} else if (event.target.id === "window-behavior-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { closeToTray: new FormData(event.target).get("closeToTray") === "on" } }, t("toast.windowSaved"));
	} else if (event.target.id === "skill-directory-form") {
		event.preventDefault();
		const directory = new FormData(event.target).get("directory");
		if (directory) await run({ type: "settings.update", patch: { skillDirectories: [...desktopState.settings.skillDirectories, directory] } }, t("toast.skillAdded"));
	} else if (event.target.id === "mcp-form") {
		event.preventDefault();
		const data = new FormData(event.target);
		const transport = data.get("transport");
		await run({ type: "mcp.create", profile: { name: data.get("name"), namespace: data.get("namespace"), transport, command: data.get("command") || null, args: String(data.get("args") || "").split("\n").map((value) => value.trim()).filter(Boolean), env: {}, url: data.get("url") || null, credentialRef: null, enabled: data.get("enabled") === "on", timeoutMs: 30000, maxOutputBytes: 1048576, projectId: null } }, t("toast.mcpUpdated"));
	}
});

document.addEventListener("input", (event) => {
	const input = event.target;
	if (!(input instanceof HTMLInputElement) || input.type !== "range") return;
	const output = byId(`${input.id}-value`);
	if (output) output.textContent = `${input.value}px`;
});

byId("model-select").addEventListener("change", async (event) => {
	if (event.target.value) await run({ type: "agent.setModel", profileId: event.target.value });
});
byId("thinking-select").addEventListener("change", async (event) => run({ type: "agent.setThinkingLevel", level: event.target.value }));
byId("prompt-input").addEventListener("input", renderSlashMenu);
byId("prompt-input").addEventListener("keydown", (event) => {
	if (slashItems.length > 0) {
		if (event.key === "ArrowDown") { event.preventDefault(); slashIndex = (slashIndex + 1) % slashItems.length; renderSlashMenu(); return; }
		if (event.key === "ArrowUp") { event.preventDefault(); slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length; renderSlashMenu(); return; }
		if (event.key === "Escape") { event.preventDefault(); slashItems = []; byId("slash-menu").classList.add("hidden"); return; }
		if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); selectSlashCommand(slashItems[slashIndex].name); return; }
	}
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); byId("prompt-form").requestSubmit(); }
});

document.addEventListener("keydown", (event) => {
	const target = event.target;
	if (!(target instanceof HTMLInputElement) || !target.matches("[data-shortcut-recorder]")) return;
	const ignored = new Set(["Control", "Alt", "Shift", "Meta", "Dead", "Process"]);
	if (ignored.has(event.key)) return;
	const aliases = { " ": "Space", Esc: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
	const key = aliases[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key);
	const modifiers = [event.ctrlKey ? "Ctrl" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : "", event.metaKey ? "Meta" : ""].filter(Boolean);
	if (modifiers.length === 0) return;
	event.preventDefault();
	target.value = [...modifiers, key].join("+");
});

document.addEventListener("toggle", (event) => {
	const target = event.target;
	if (target instanceof HTMLDetailsElement && target.dataset.reasoningId) reasoningOpen.set(target.dataset.reasoningId, target.open);
}, true);

hydrateIcons();
startEventStream();
await refresh();
