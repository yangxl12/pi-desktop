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

/** Content-Type for files served through the project file preview endpoint. */
export function previewFileContentType(filePath: string): string {
	const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	switch (extension) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
		case ".mjs":
			return "text/javascript; charset=utf-8";
		case ".json":
		case ".jsonl":
		case ".geojson":
			return "application/json; charset=utf-8";
		case ".md":
		case ".markdown":
		case ".mdx":
			return "text/markdown; charset=utf-8";
		case ".html":
		case ".htm":
			return "text/html; charset=utf-8";
		case ".xml":
			return "application/xml; charset=utf-8";
		case ".svg":
			return "image/svg+xml; charset=utf-8";
		case ".txt":
		case ".csv":
		case ".tsv":
		case ".yaml":
		case ".yml":
		case ".toml":
			return "text/plain; charset=utf-8";
		case ".pdf":
			return "application/pdf";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		case ".avif":
			return "image/avif";
		case ".bmp":
			return "image/bmp";
		case ".ico":
			return "image/x-icon";
		case ".docx":
			return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case ".xlsx":
			return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		case ".pptx":
			return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		case ".zip":
			return "application/zip";
		default:
			return "application/octet-stream";
	}
}
