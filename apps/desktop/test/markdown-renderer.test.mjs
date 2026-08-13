import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/renderer/markdown-renderer.mjs";

describe("assistant markdown renderer", () => {
	it("renders GFM tables, lists, blockquotes, and fenced code", () => {
		const html = renderMarkdown(`| Name | State |
| --- | ---: |
| build | ready |

- first
  - nested

> quoted

\`\`\`js
const answer = 42;
\`\`\``);

		expect(html).toContain("<table>");
		expect(html).toContain("<ul>");
		expect(html).toContain("<blockquote>");
		expect(html).toContain('<code class="language-js">const answer = 42;');
		expect(html).toContain("</code></pre>");
	});

	it("keeps external and project preview links while rejecting unsafe URLs and raw HTML", () => {
		const html = renderMarkdown(
			"[web](https://example.com) [file](docs/readme.md) [bad](javascript:alert(1)) <script>alert(1)</script>",
			{ previewTitle: "Preview" },
		);

		expect(html).toContain('target="_blank"');
		expect(html).toContain('data-file-path="docs/readme.md"');
		expect(html).toContain('title="Preview"');
		expect(html).not.toContain('href="javascript:');
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
