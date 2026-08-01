import { DesktopError } from "@earendil-works/pi-desktop-protocol";

export function normalizeModelBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new DesktopError("INVALID_ARGUMENT", "Model base URL is invalid");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new DesktopError("INVALID_ARGUMENT", "Model base URL must use HTTP or HTTPS");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new DesktopError("INVALID_ARGUMENT", "Model base URL cannot contain credentials, query, or fragment");
	}
	return url.toString().replace(/\/$/, "");
}
