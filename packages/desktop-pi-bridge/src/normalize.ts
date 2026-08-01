import type { PiAgentEventPayload, PiAgentState, PiCommandInfo } from "@earendil-works/pi-desktop-core";
import type { DesktopMessage, MessagePart, ThinkingLevel } from "@earendil-works/pi-desktop-protocol";

interface RawRecord {
	type?: string;
	[key: string]: unknown;
}

function record(value: unknown): RawRecord | undefined {
	return typeof value === "object" && value !== null ? (value as RawRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function stableMessageId(message: RawRecord): string {
	const explicitId = stringValue(message.id) ?? stringValue(message.responseId);
	if (explicitId) return explicitId;
	const timestamp = numberValue(message.timestamp) ?? 0;
	return `message-${message.role ?? "unknown"}-${timestamp}`;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const item = record(part);
			return stringValue(item?.text) ?? stringValue(item?.thinking) ?? "";
		})
		.join("");
}

export function normalizeMessage(value: unknown): DesktopMessage {
	const message = record(value) ?? {};
	const role =
		message.role === "user" || message.role === "assistant" || message.role === "system" ? message.role : "tool";
	const parts: MessagePart[] = [];
	if (Array.isArray(message.content)) {
		for (const rawPart of message.content) {
			const part = record(rawPart);
			if (!part) continue;
			const type = stringValue(part.type);
			if (type === "text") parts.push({ type: "text", text: stringValue(part.text) ?? "" });
			else if (type === "thinking") parts.push({ type: "thinking", text: stringValue(part.thinking) ?? "" });
			else if (type === "toolCall")
				parts.push({
					type: "tool",
					text: JSON.stringify(part.arguments ?? ""),
					toolName: stringValue(part.name),
					toolCallId: stringValue(part.id),
				});
		}
	} else {
		parts.push({ type: "text", text: textFromContent(message.content) });
	}
	if (parts.length === 0) parts.push({ type: "text", text: "" });
	const stopReason = stringValue(message.stopReason);
	return {
		id: stableMessageId(message),
		role,
		parts,
		createdAt: new Date(numberValue(message.timestamp) ?? Date.now()).toISOString(),
		status: stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "finished",
	};
}

function normalizeThinkingLevel(value: unknown): ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value as string)
		? (value as ThinkingLevel)
		: "off";
}

export function normalizeState(value: unknown): PiAgentState {
	const state = record(value) ?? {};
	const model = record(state.model);
	return {
		isStreaming: state.isStreaming === true,
		thinkingLevel: normalizeThinkingLevel(state.thinkingLevel),
		modelProvider: stringValue(model?.provider) ?? null,
		modelId: stringValue(model?.id) ?? null,
		sessionPath: stringValue(state.sessionFile) ?? null,
		sessionId: stringValue(state.sessionId) ?? null,
		messageCount: numberValue(state.messageCount) ?? 0,
	};
}

export function normalizeCommands(value: unknown): PiCommandInfo[] {
	const data = record(value);
	if (!Array.isArray(data?.commands)) return [];
	return data.commands.flatMap((command) => {
		const item = record(command);
		const name = stringValue(item?.name);
		const sourceInfo = record(item?.sourceInfo);
		const scope = stringValue(sourceInfo?.scope);
		return name
			? [
					{
						name,
						description: stringValue(item?.description),
						source: stringValue(item?.source) ?? "pi",
						path: stringValue(sourceInfo?.path),
						scope: scope === "user" || scope === "project" || scope === "temporary" ? scope : undefined,
					},
				]
			: [];
	});
}

export function normalizePiEvent(value: unknown): PiAgentEventPayload | undefined {
	const event = record(value);
	if (!event?.type) return undefined;
	if (event.type === "message_start") return { type: "message_started", message: normalizeMessage(event.message) };
	if (event.type === "message_end") return { type: "message_finished", message: normalizeMessage(event.message) };
	if (event.type === "message_update") {
		const update = record(event.assistantMessageEvent);
		const part = update?.type === "thinking_delta" ? "thinking" : update?.type === "text_delta" ? "text" : undefined;
		const delta = stringValue(update?.delta);
		if (part && delta)
			return { type: "message_delta", messageId: stableMessageId(record(event.message) ?? {}), part, delta };
		return undefined;
	}
	if (event.type === "tool_execution_start")
		return {
			type: "tool_started",
			messageId: "tool",
			toolName: stringValue(event.toolName) ?? "tool",
			toolCallId: stringValue(event.toolCallId) ?? "",
		};
	if (event.type === "tool_execution_update")
		return {
			type: "tool_update",
			messageId: "tool",
			toolCallId: stringValue(event.toolCallId) ?? "",
			text: JSON.stringify(event.partialResult ?? ""),
		};
	if (event.type === "tool_execution_end")
		return {
			type: "tool_finished",
			messageId: "tool",
			toolCallId: stringValue(event.toolCallId) ?? "",
			text: JSON.stringify(event.result ?? ""),
			failed: event.isError === true,
		};
	if (event.type === "agent_end" || event.type === "agent_settled")
		return {
			type: "state_changed",
			state: {
				isStreaming: false,
				thinkingLevel: "off",
				modelProvider: null,
				modelId: null,
				sessionPath: null,
				sessionId: null,
				messageCount: 0,
			},
		};
	if (event.type === "thinking_level_changed")
		return {
			type: "state_changed",
			state: {
				isStreaming: false,
				thinkingLevel: normalizeThinkingLevel(event.level),
				modelProvider: null,
				modelId: null,
				sessionPath: null,
				sessionId: null,
				messageCount: 0,
			},
		};
	if (event.type === "auto_retry_end" && event.success === false)
		return { type: "error", error: stringValue(event.finalError) ?? "Pi retry failed" };
	return undefined;
}
