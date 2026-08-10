/** Maps renderer resource paths to the HTTP Content-Type used by the host. */
export function rendererContentType(filePath: string): string {
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	switch (extension) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		default:
			return "text/html; charset=utf-8";
	}
}
