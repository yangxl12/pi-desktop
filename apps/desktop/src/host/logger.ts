import type { DesktopLogger } from "@earendil-works/pi-desktop-core";
import type { Diagnostic } from "@earendil-works/pi-desktop-protocol";
import { redactDiagnosticText } from "./diagnostics.ts";

export class ConsoleDesktopLogger implements DesktopLogger {
	info(message: string, context?: Record<string, string>): void {
		console.info(JSON.stringify({ level: "info", message: redactDiagnosticText(message), ...context }));
	}
	error(message: string, context?: Record<string, string>): void {
		console.error(JSON.stringify({ level: "error", message: redactDiagnosticText(message), ...context }));
	}
	diagnostic(diagnostic: Diagnostic): void {
		(diagnostic.level === "error" ? console.error : console.info)(
			JSON.stringify({ ...diagnostic, message: redactDiagnosticText(diagnostic.message) }),
		);
	}
}
