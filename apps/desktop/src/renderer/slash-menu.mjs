export function commandTokenAtCaret(text, caret = text.length) {
	const before = text.slice(0, caret);
	if (before.includes("\n")) return null;
	const leading = before.match(/^\s*/)?.[0].length ?? 0;
	if (before.slice(leading, leading + 1) !== "/") return null;
	const tokenStart = leading;
	const token = before.slice(tokenStart).match(/^\/[^\s]*/)?.[0] ?? "";
	if (!token || before.length > tokenStart + token.length) return null;
	return { start: tokenStart, end: tokenStart + token.length, query: token.slice(1), token };
}

export function filterSlashCommands(commands, query, limit = 10) {
	const normalized = String(query ?? "").toLowerCase();
	return [...commands]
		.map((command) => {
			const name = command.name.toLowerCase();
			const prefix = name.startsWith(normalized);
			const word = !prefix && name.split(/[^a-z0-9]+/i).some((part) => part.startsWith(normalized));
			const substring = !prefix && !word && name.includes(normalized);
			return { command, rank: prefix ? 0 : word ? 1 : substring ? 2 : 99 };
		})
		.filter((entry) => entry.rank < 99)
		.sort((a, b) => a.rank - b.rank || (a.command.source === "skill" ? -1 : 1) - (b.command.source === "skill" ? -1 : 1) || a.command.name.localeCompare(b.command.name))
		.slice(0, limit)
		.map((entry) => entry.command);
}

export function replaceCommandToken(text, caret, commandName) {
	const token = commandTokenAtCaret(text, caret);
	if (!token) return { text, caret };
	const replacement = `/${commandName} `;
	const next = `${text.slice(0, token.start)}${replacement}${text.slice(token.end)}`;
	return { text: next, caret: token.start + replacement.length };
}

export function cycleSelection(length, current, delta) {
	if (!length) return 0;
	return (current + delta + length) % length;
}
