import type { DesktopErrorCode, DesktopErrorShape } from "./types.ts";

export class DesktopError extends Error {
	readonly code: DesktopErrorCode;
	readonly details: Record<string, unknown> | undefined;

	constructor(code: DesktopErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "DesktopError";
		this.code = code;
		this.details = details;
	}

	toJSON(): DesktopErrorShape {
		return { code: this.code, message: this.message, details: this.details };
	}
}

export function toDesktopError(error: unknown, fallbackCode: DesktopErrorCode = "INTERNAL_ERROR"): DesktopError {
	if (error instanceof DesktopError) return error;
	return new DesktopError(fallbackCode, error instanceof Error ? error.message : String(error));
}
