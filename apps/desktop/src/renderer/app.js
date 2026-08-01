import { createElement, icons } from "/vendor/lucide/lucide.mjs";

let desktopState = null;
let settingsOpen = false;
let settingsTab = "models";
let editingModelId = null;
let selectedQueue = null;
let slashItems = [];
let slashIndex = 0;
let toastTimer;

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const iconName = (value) => value.split("-").map((piece) => piece[0].toUpperCase() + piece.slice(1)).join("");

function hydrateIcons(root = document) {
	for (const target of root.querySelectorAll("[data-icon]")) {
		const node = icons[iconName(target.dataset.icon)] ?? icons.Circle;
		const svg = createElement(node, { width: 16, height: 16, "aria-hidden": "true", "stroke-width": 1.8 });
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
	byId("project-count").textContent = String(desktopState.projects.length);
	if (desktopState.projects.length === 0) {
		container.innerHTML = '<button class="project-button" data-action="add-project"><span data-icon="folder-plus"></span><span class="project-name">Add project</span></button>';
		hydrateIcons(container);
		return;
	}
	container.innerHTML = desktopState.projects.map((project) => {
		const active = project.id === desktopState.activeProjectId;
		const sessions = active ? desktopState.conversations.map((session) => `
			<button class="session-button ${session.id === desktopState.activeSessionId ? "active" : ""}" data-action="select-session" data-session-id="${escapeHtml(session.id)}">
				<span class="session-status ${escapeHtml(session.status)}"></span>
				<span class="session-name">${escapeHtml(session.title)}</span>
				<span class="row-action" data-action="rename-session" data-session-id="${escapeHtml(session.id)}" title="Rename session" aria-label="Rename session"><span data-icon="pencil"></span></span>
			</button>`).join("") : "";
		return `<div class="project-item">
			<button class="project-button ${active ? "active" : ""}" data-action="select-project" data-project-id="${escapeHtml(project.id)}">
				<span data-icon="folder"></span>
				<span class="project-name" title="${escapeHtml(project.rootPath)}">${escapeHtml(project.name)}</span>
				<span class="trust-pill ${escapeHtml(project.trustState)}">${escapeHtml(project.trustState)}</span>
				<span class="row-action" data-action="rename-project" data-project-id="${escapeHtml(project.id)}" title="Rename project" aria-label="Rename project"><span data-icon="pencil"></span></span>
			</button>
			${active ? `<div class="project-path" title="${escapeHtml(project.rootPath)}">${escapeHtml(project.rootPath)}</div><div class="session-list"><button class="session-button" data-action="new-session" data-project-id="${escapeHtml(project.id)}"><span data-icon="message-square-plus"></span><span class="session-name">New conversation</span></button>${sessions}</div>` : ""}
		</div>`;
	}).join("");
	hydrateIcons(container);
}

function renderHeader() {
	const project = activeProject();
	const session = activeSession();
	byId("project-title").textContent = project?.name ?? "No project";
	byId("session-title").textContent = session?.title ?? "New conversation";
	const runtime = desktopState.runtime;
	const status = runtime?.status ?? "idle";
	byId("runtime-dot").className = `status-dot ${status}`;
	byId("runtime-mini-label").textContent = runtime ? status[0].toUpperCase() + status.slice(1) : "No runtime";
	const modelSelect = byId("model-select");
	const enabledModels = desktopState.models.filter((model) => model.enabled);
	modelSelect.innerHTML = `<option value="">No model</option>${enabledModels.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName)}</option>`).join("")}`;
	const currentModel = enabledModels.find((model) => model.providerId === runtime?.modelProvider && model.modelId === runtime?.modelId);
	modelSelect.value = currentModel?.id ?? "";
	modelSelect.disabled = !runtime || runtime.isStreaming;
	byId("thinking-select").value = runtime?.thinkingLevel ?? "off";
	byId("thinking-select").disabled = !runtime || runtime.isStreaming;
}

function renderTrustBanner() {
	const project = activeProject();
	const banner = byId("trust-banner");
	if (!project || project.trustState === "trusted") {
		banner.classList.add("hidden");
		return;
	}
	banner.classList.remove("hidden");
	banner.innerHTML = `<div><strong>${project.trustState === "unknown" ? "Project trust required" : "Restricted project"}</strong><div>${escapeHtml(project.rootPath)}</div></div><div class="banner-actions"><button class="text-button" data-action="set-trust" data-project-id="${escapeHtml(project.id)}" data-trust="untrusted">Keep restricted</button><button class="text-button primary" data-action="set-trust" data-project-id="${escapeHtml(project.id)}" data-trust="trusted">Trust project</button></div>`;
}

function messageText(message) {
	return message.parts.map((part) => part.text).join("");
}

function renderMessages() {
	const container = byId("messages");
	if (!desktopState.activeProjectId) {
		container.innerHTML = '<div class="empty-state"><h1>No project selected</h1><p>Add a local project folder to begin.</p><div class="form-actions"><button class="text-button primary" data-action="add-project"><span data-icon="folder-plus"></span> Add project</button></div></div>';
		hydrateIcons(container);
		return;
	}
	if (desktopState.messages.length === 0) {
		container.innerHTML = '<div class="empty-state"><h1>New conversation</h1><p>Pi is ready for work in this project.</p></div>';
		return;
	}
	container.innerHTML = desktopState.messages.map((message) => {
		const content = message.parts.filter((part) => part.type === "text" || part.type === "error").map((part) => escapeHtml(part.text)).join("");
		const thinking = message.parts.filter((part) => part.type === "thinking").map((part) => escapeHtml(part.text)).join("");
		const tools = message.parts.filter((part) => part.type === "tool").map((part) => `<div class="message-tool"><strong>${escapeHtml(part.toolName ?? "tool")}</strong>\n${escapeHtml(part.text)}</div>`).join("");
		return `<article class="message ${escapeHtml(message.role)}">
			<div class="message-head"><span class="message-role">${message.role === "assistant" ? "Pi" : escapeHtml(message.role)}</span><span>${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span><span>${escapeHtml(message.status ?? "")}</span></div>
			${thinking ? `<details class="message thinking"><summary>Thinking</summary><div class="message-body">${thinking}</div></details>` : ""}
			<div class="message-body">${content}${tools}<div class="message-actions"><button data-action="copy-message" data-message-id="${escapeHtml(message.id)}" title="Copy message" aria-label="Copy message"><span data-icon="copy"></span></button></div></div>
		</article>`;
	}).join("");
	hydrateIcons(container);
	container.scrollTop = container.scrollHeight;
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
		errorRow.innerHTML = `${escapeHtml(runtime.lastError ?? "Runtime failed")} <button class="text-button" data-action="retry-last">Retry</button>`;
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
	byId("settings-section-title").textContent = settingsTab[0].toUpperCase() + settingsTab.slice(1);
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
	content.innerHTML = `<section class="settings-section"><h2>Models</h2><p>${desktopState.models.length} configured</p>
		<div class="settings-card"><h3>${editing ? "Edit model" : "Add model"}</h3><form id="model-form" class="form-grid">
			<label class="form-field"><span>Name</span><input name="displayName" required value="${escapeHtml(editing?.displayName ?? "")}"></label>
			<label class="form-field"><span>Provider ID</span><input name="providerId" required value="${escapeHtml(editing?.providerId ?? "openai-compatible")}"></label>
			<label class="form-field full"><span>Base URL</span><input name="baseUrl" type="url" required placeholder="http://localhost:11434/v1" value="${escapeHtml(editing?.baseUrl ?? "")}"></label>
			<label class="form-field"><span>Model ID</span><input name="modelId" required value="${escapeHtml(editing?.modelId ?? "")}"></label>
			<label class="form-field"><span>API key</span><input name="apiKey" type="password" autocomplete="new-password" placeholder="${editing?.credentialRef ? "Stored; leave blank to keep" : "Optional for local endpoints"}"></label>
			<label class="form-field"><span><input name="enabled" type="checkbox" ${editing?.enabled === false ? "" : "checked"}> Enabled</span></label>
			<div class="form-actions full">${editing ? '<button type="button" class="text-button" data-action="cancel-model-edit">Cancel</button>' : ""}<button class="text-button primary" type="submit"><span data-icon="save"></span> Save</button></div>
		</form></div>
		<div class="settings-card"><h3>Profiles</h3>${desktopState.models.length === 0 ? '<div class="muted">No model profiles</div>' : desktopState.models.map((model) => `<div class="model-row"><div class="model-info"><strong>${escapeHtml(model.displayName)}${model.enabled ? "" : " / disabled"}</strong><span>${escapeHtml(model.providerId)}/${escapeHtml(model.modelId)} / ${escapeHtml(model.baseUrl)}${model.credentialRef ? " / credential stored" : ""}</span></div><div class="model-actions"><button class="icon-button" data-action="default-model" data-profile-id="${escapeHtml(model.id)}" title="Set as default" aria-label="Set as default"><span data-icon="star"></span></button><button class="icon-button" data-action="test-model" data-profile-id="${escapeHtml(model.id)}" title="Test connection" aria-label="Test connection"><span data-icon="plug-zap"></span></button><button class="icon-button" data-action="edit-model" data-profile-id="${escapeHtml(model.id)}" title="Edit model" aria-label="Edit model"><span data-icon="pencil"></span></button><button class="icon-button" data-action="delete-model" data-profile-id="${escapeHtml(model.id)}" title="Delete model" aria-label="Delete model"><span data-icon="trash-2"></span></button></div></div>`).join("")}</div>
	</section>`;
}

function renderGeneralSettings(content) {
	content.innerHTML = `<section class="settings-section"><h2>General</h2><p>Application defaults</p>
		<div class="settings-card"><h3>Global system prompt</h3><form id="global-prompt-form"><label class="form-field"><textarea name="globalSystemPrompt">${escapeHtml(desktopState.settings.globalSystemPrompt)}</textarea></label><div class="form-actions"><button class="text-button primary" type="submit"><span data-icon="save"></span> Save</button></div></form></div>
		<div class="settings-card"><h3>Global shortcut</h3><form id="shortcut-form" class="form-grid"><label class="form-field full"><input name="invokeShortcut" value="${escapeHtml(desktopState.settings.invokeShortcut)}"></label><div class="form-actions full"><button class="text-button" type="button" data-action="reset-shortcut"><span data-icon="rotate-ccw"></span> Reset</button><button class="text-button primary" type="submit"><span data-icon="save"></span> Save</button></div></form></div>
		<div class="settings-card"><h3>Window behavior</h3><form id="window-behavior-form"><label class="form-field"><span><input name="closeToTray" type="checkbox" ${desktopState.settings.closeToTray ? "checked" : ""}> Keep Pi Desktop running in the system tray when the window is closed</span></label><div class="form-actions"><button class="text-button primary" type="submit"><span data-icon="save"></span> Save</button></div></form></div>
	</section>`;
}

function renderSkillsSettings(content) {
	const skills = desktopState.commands.filter((commandInfo) => commandInfo.source === "skill");
	content.innerHTML = `<section class="settings-section"><h2>Skills</h2><p>${skills.length} loaded</p>
		<div class="settings-card"><h3>Directories</h3><form id="skill-directory-form" class="form-grid"><label class="form-field full"><input name="directory" required placeholder="Skill directory or SKILL.md path"></label><div class="form-actions full"><button class="text-button primary" type="submit"><span data-icon="plus"></span> Add</button></div></form>${desktopState.settings.skillDirectories.map((directory) => `<div class="directory-row"><span title="${escapeHtml(directory)}">${escapeHtml(directory)}</span><button class="icon-button" data-action="remove-skill-directory" data-directory="${escapeHtml(directory)}" title="Remove directory" aria-label="Remove directory"><span data-icon="x"></span></button></div>`).join("")}<div class="form-actions"><button class="text-button" data-action="reload-skills"><span data-icon="refresh-cw"></span> Rescan</button></div></div>
		<div class="settings-card"><h3>Loaded commands</h3>${skills.length === 0 ? '<div class="muted">No skills loaded</div>' : skills.map((skill) => `<div class="directory-row"><span><strong>/${escapeHtml(skill.name)}</strong><br><span class="muted">${escapeHtml(skill.description ?? "")}</span></span><span class="trust-pill ${escapeHtml(skill.scope ?? "temporary")}">${escapeHtml(skill.scope ?? "temporary")}</span></div>`).join("")}</div>
	</section>`;
}

function renderMcpSettings(content) {
	const servers = desktopState.mcpServers ?? [];
	content.innerHTML = `<section class="settings-section"><h2>MCP servers</h2><p>${servers.length} configured</p>
		<div class="settings-card"><h3>Add server</h3><form id="mcp-form" class="form-grid">
			<label class="form-field"><span>Name</span><input name="name" required placeholder="Filesystem"></label>
			<label class="form-field"><span>Namespace</span><input name="namespace" required pattern="[A-Za-z][A-Za-z0-9_-]*" placeholder="filesystem"></label>
			<label class="form-field"><span>Transport</span><select name="transport"><option value="stdio">STDIO</option><option value="http">HTTP</option></select></label>
			<label class="form-field"><span>Command</span><input name="command" placeholder="npx"></label>
			<label class="form-field full"><span>Arguments (one per line)</span><textarea name="args" rows="2" placeholder="-y\n@modelcontextprotocol/server-filesystem"></textarea></label>
			<label class="form-field full"><span>HTTP URL (for HTTP transport)</span><input name="url" type="url" placeholder="https://localhost:3000/mcp"></label>
			<label class="form-field"><span><input name="enabled" type="checkbox" checked> Enabled</span></label>
			<div class="form-actions full"><button class="text-button primary" type="submit"><span data-icon="plus"></span>Add server</button></div>
		</form></div>
		<div class="settings-card"><h3>Configured servers</h3>${servers.length === 0 ? '<div class="muted">No MCP servers</div>' : servers.map((server) => `<div class="model-row"><div class="model-info"><strong>${escapeHtml(server.profile.name)} / ${escapeHtml(server.status)}</strong><span>${escapeHtml(server.profile.transport)} / ${escapeHtml(server.profile.namespace)} / ${server.toolCount} tools${server.lastError ? ` / ${escapeHtml(server.lastError)}` : ""}</span></div><div class="model-actions"><button class="icon-button" data-action="toggle-mcp" data-server-id="${escapeHtml(server.profile.id)}" title="${server.profile.enabled ? "Disable" : "Enable"} server" aria-label="Toggle MCP server"><span data-icon="${server.profile.enabled ? "pause" : "play"}"></span></button><button class="icon-button" data-action="test-mcp" data-server-id="${escapeHtml(server.profile.id)}" title="Test connection" aria-label="Test MCP connection"><span data-icon="plug-zap"></span></button><button class="icon-button" data-action="delete-mcp" data-server-id="${escapeHtml(server.profile.id)}" title="Delete server" aria-label="Delete MCP server"><span data-icon="trash-2"></span></button></div></div>`).join("")}</div>
	</section>`;
}

function renderDiagnosticsSettings(content) {
	const diagnostics = [...desktopState.diagnostics].reverse();
	content.innerHTML = `<section class="settings-section"><h2>Diagnostics</h2><p>${diagnostics.length} recent entries</p><div class="settings-card"><h3>Runtime</h3><div class="directory-row"><span>Status</span><strong>${escapeHtml(desktopState.runtime?.status ?? "stopped")}</strong></div><div class="directory-row"><span>Runtime ID</span><strong>${escapeHtml(desktopState.runtime?.runtimeId ?? "-")}</strong></div><div class="directory-row"><span>Session file</span><strong title="${escapeHtml(desktopState.runtime?.sessionPath ?? "")}">${escapeHtml(desktopState.runtime?.sessionPath ?? "-")}</strong></div><div class="form-actions"><button class="text-button" data-action="export-diagnostics"><span data-icon="download"></span>Export diagnostics</button></div></div><div class="settings-card"><h3>Recent events</h3>${diagnostics.length === 0 ? '<div class="muted">No diagnostics</div>' : diagnostics.map((diagnostic) => `<div class="diagnostic-row"><strong>${escapeHtml(diagnostic.level)} / ${escapeHtml(diagnostic.component)}</strong><span>${escapeHtml(diagnostic.message)}</span></div>`).join("")}</div></section>`;
}

function render() {
	renderProjectTree();
	renderHeader();
	renderTrustBanner();
	renderMessages();
	renderComposer();
	byId("chat-view").classList.toggle("hidden", settingsOpen);
	byId("settings-view").classList.toggle("hidden", !settingsOpen);
	if (settingsOpen && !byId("settings-content").contains(document.activeElement)) renderSettings();
}

async function refresh() {
	try {
		desktopState = await (await fetch("/api/state", { cache: "no-store" })).json();
		render();
	} catch (error) {
		showToast(error instanceof Error ? error.message : String(error), "error");
	}
}

function selectSlashCommand(commandName) {
	const input = byId("prompt-input");
	input.value = `/${commandName} `;
	slashItems = [];
	renderSlashMenu();
	input.focus();
}

document.addEventListener("click", async (event) => {
	const actionTarget = event.target.closest("[data-action]");
	if (!actionTarget) return;
	event.preventDefault();
	const action = actionTarget.dataset.action;
	if (action === "add-project") await run({ type: "projects.addFromFolder" });
	else if (action === "select-project") await run({ type: "projects.select", projectId: actionTarget.dataset.projectId });
	else if (action === "new-session") await run({ type: "sessions.create", projectId: actionTarget.dataset.projectId });
	else if (action === "select-session") await run({ type: "sessions.open", sessionId: actionTarget.dataset.sessionId });
	else if (action === "rename-session") {
		const session = desktopState.conversations.find((candidate) => candidate.id === actionTarget.dataset.sessionId);
		const title = window.prompt("Session name", session?.title ?? "");
		if (title) await run({ type: "sessions.rename", sessionId: actionTarget.dataset.sessionId, title });
	} else if (action === "rename-project") {
		const project = desktopState.projects.find((candidate) => candidate.id === actionTarget.dataset.projectId);
		const name = window.prompt("Project name", project?.name ?? "");
		if (name) await run({ type: "projects.rename", projectId: actionTarget.dataset.projectId, name });
	} else if (action === "set-trust") await run({ type: "projects.setTrust", projectId: actionTarget.dataset.projectId, trustState: actionTarget.dataset.trust });
	else if (action === "open-settings") { settingsOpen = true; render(); }
	else if (action === "close-settings") { settingsOpen = false; editingModelId = null; render(); }
	else if (action === "abort") await run({ type: "agent.abort" });
	else if (action === "retry-last") await run({ type: "agent.retryLast" });
	else if (action === "clear-prompt") { byId("prompt-input").value = ""; renderSlashMenu(); byId("prompt-input").focus(); }
	else if (action === "copy-message") {
		const message = desktopState.messages.find((candidate) => candidate.id === actionTarget.dataset.messageId);
		if (message) { await navigator.clipboard.writeText(messageText(message)); showToast("Message copied"); }
	} else if (action === "select-command") selectSlashCommand(actionTarget.dataset.command);
	else if (action === "edit-model") { editingModelId = actionTarget.dataset.profileId; settingsTab = "models"; renderSettings(); }
	else if (action === "cancel-model-edit") { editingModelId = null; renderSettings(); }
	else if (action === "delete-model") { if (window.confirm("Delete this model profile?")) await run({ type: "models.delete", profileId: actionTarget.dataset.profileId }, "Model deleted"); }
	else if (action === "test-model") {
		const result = await run({ type: "models.testConnection", profileId: actionTarget.dataset.profileId });
		if (result) showToast(`${result.message} / ${result.latencyMs} ms`, result.ok ? "info" : "error");
	} else if (action === "default-model") await run({ type: "models.setDefault", profileId: actionTarget.dataset.profileId }, "Default model updated");
	else if (action === "remove-skill-directory") await run({ type: "settings.update", patch: { skillDirectories: desktopState.settings.skillDirectories.filter((directory) => directory !== actionTarget.dataset.directory) } }, "Skill directory removed");
	else if (action === "reload-skills") await run({ type: "skills.reload" }, "Skills rescanned");
	else if (action === "toggle-mcp") {
		const server = (desktopState.mcpServers ?? []).find((candidate) => candidate.profile.id === actionTarget.dataset.serverId);
		if (server) await run({ type: "mcp.setEnabled", serverId: server.profile.id, enabled: !server.profile.enabled }, "MCP server updated");
	} else if (action === "test-mcp") {
		const result = await run({ type: "mcp.testConnection", serverId: actionTarget.dataset.serverId });
		if (result) showToast(result.status === "ready" ? "MCP connection successful" : (result.lastError ?? "MCP connection failed"), result.status === "ready" ? "info" : "error");
	} else if (action === "delete-mcp") {
		if (window.confirm("Delete this MCP server?")) await run({ type: "mcp.delete", serverId: actionTarget.dataset.serverId }, "MCP server deleted");
	}
	else if (action === "reset-shortcut") await run({ type: "settings.reset", key: "invokeShortcut" }, "Shortcut reset");
	else if (action === "export-diagnostics") {
		const path = await run({ type: "app.exportDiagnostics" });
		if (path) showToast(`Diagnostics exported to ${path}`);
	}
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
		if (streaming && !selectedQueue) { showToast("Select steer or follow up before sending", "error"); return; }
		const result = await run({ type: "agent.prompt", text, queueMode: streaming ? selectedQueue : "prompt" });
		if (result !== undefined) { input.value = ""; selectedQueue = null; renderSlashMenu(); }
	} else if (event.target.id === "model-form") {
		event.preventDefault();
		const data = new FormData(event.target);
		const profile = { displayName: data.get("displayName"), providerId: data.get("providerId"), baseUrl: data.get("baseUrl"), modelId: data.get("modelId"), enabled: data.get("enabled") === "on" };
		const apiKey = data.get("apiKey") || undefined;
		const commandValue = editingModelId ? { type: "models.update", profileId: editingModelId, patch: profile, apiKey } : { type: "models.create", profile, apiKey };
		const result = await run(commandValue, "Model saved");
		if (result) { editingModelId = null; renderSettings(); }
	} else if (event.target.id === "global-prompt-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { globalSystemPrompt: new FormData(event.target).get("globalSystemPrompt") } }, "Global prompt saved");
	} else if (event.target.id === "shortcut-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { invokeShortcut: new FormData(event.target).get("invokeShortcut") } }, "Shortcut saved");
	} else if (event.target.id === "window-behavior-form") {
		event.preventDefault();
		await run({ type: "settings.update", patch: { closeToTray: new FormData(event.target).get("closeToTray") === "on" } }, "Window behavior saved");
	} else if (event.target.id === "skill-directory-form") {
		event.preventDefault();
		const directory = new FormData(event.target).get("directory");
		if (directory) await run({ type: "settings.update", patch: { skillDirectories: [...desktopState.settings.skillDirectories, directory] } }, "Skill directory added");
	} else if (event.target.id === "mcp-form") {
		event.preventDefault();
		const data = new FormData(event.target);
		const transport = data.get("transport");
		await run({ type: "mcp.create", profile: { name: data.get("name"), namespace: data.get("namespace"), transport, command: data.get("command") || null, args: String(data.get("args") || "").split("\n").map((value) => value.trim()).filter(Boolean), env: {}, url: data.get("url") || null, credentialRef: null, enabled: data.get("enabled") === "on", timeoutMs: 30000, maxOutputBytes: 1048576, projectId: null } }, "MCP server added");
	}
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

hydrateIcons();
await refresh();
setInterval(() => void refresh(), 900);
