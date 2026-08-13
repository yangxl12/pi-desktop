import { Marked, Renderer } from "marked";

const PREVIEWABLE_PATH = /\.(?:md|markdown|html?|json|ya?ml|toml|txt|csv|svg|png|jpe?g|gif|webp|avif|bmp|ico|pdf|docx|xlsx|pptx|zip)$/i;

const escapeHtml = (value) =>
	String(value ?? "").replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character]);

const safeExternalUrl = (href) => {
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
};

const previewPath = (href) => {
	const path = String(href ?? "").trim();
	if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(path)) return null;
	if (path.split(/[\\/]/).some((segment) => segment === "..")) return null;
	const withoutQuery = path.split(/[?#]/, 1)[0];
	return PREVIEWABLE_PATH.test(withoutQuery) ? path : null;
};

export function renderMarkdown(value, options = {}) {
	const renderer = new Renderer();
	renderer.html = ({ text }) => escapeHtml(text);
	renderer.link = function ({ href, title, tokens }) {
		const label = this.parser.parseInline(tokens);
		const externalUrl = safeExternalUrl(href);
		if (externalUrl) {
			return `<a href="${escapeHtml(externalUrl)}"${title ? ` title="${escapeHtml(title)}"` : ""} target="_blank" rel="noreferrer">${label}</a>`;
		}
		const path = previewPath(href);
		if (path) {
			return `<a href="#" data-action="preview-file" data-file-path="${escapeHtml(path)}" title="${escapeHtml(options.previewTitle ?? "Open preview")}">${label}</a>`;
		}
		return label;
	};
	renderer.image = ({ text }) => escapeHtml(text);

	const marked = new Marked({
		async: false,
		breaks: true,
		gfm: true,
		renderer,
	});
	return marked.parse(String(value ?? ""));
}
