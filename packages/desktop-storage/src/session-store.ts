import type {
	SessionCodec,
	SessionHandle,
	SessionPage,
	SessionStore as SessionStoreContract,
} from "@earendil-works/pi-desktop-core";
import { sessionHandle } from "@earendil-works/pi-desktop-core";
import type { DesktopMessage } from "@earendil-works/pi-desktop-protocol";

/** Filesystem-backed SessionStore. SQLite remains a rebuildable metadata index. */
export class FileSessionStore implements SessionStoreContract {
	readonly codec: SessionCodec;

	constructor(codec: SessionCodec) {
		this.codec = codec;
	}

	private ref(handle: SessionHandle | string): string {
		return typeof handle === "string" ? handle : handle.opaqueRef;
	}

	readSummary(handle: SessionHandle | string) {
		return this.codec.readSummary(this.ref(handle));
	}

	readMessages(handle: SessionHandle | string): Promise<DesktopMessage[]> {
		return this.codec.readMessages(this.ref(handle));
	}

	exists(handle: SessionHandle | string): Promise<boolean> {
		return Promise.resolve(this.codec.canRead(this.ref(handle)));
	}

	async list(
		directory: string,
		options: { projectId?: string; limit?: number; cursor?: string } = {},
	): Promise<SessionPage> {
		const result = await this.codec.scan(directory);
		const sorted = [...result.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		const start = options.cursor ? Math.max(0, Number.parseInt(options.cursor, 10) || 0) : 0;
		const limit = Math.max(1, Math.min(200, options.limit ?? 50));
		const page = sorted.slice(start, start + limit).map((summary) => ({
			id: summary.id,
			projectId: options.projectId ?? "",
			sessionPath: summary.sessionPath,
			runtimeProviderId: summary.runtimeProviderId ?? "pi",
			runtimeSessionRef: summary.runtimeSessionRef ?? summary.sessionPath,
			sessionCodecId: summary.sessionCodecId ?? this.codec.id,
			sessionFormatVersion: summary.sessionFormatVersion ?? this.codec.formatVersion,
			historyAccess: summary.historyAccess ?? "continue",
			title: summary.title,
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
			modelProvider: summary.modelProvider,
			modelId: summary.modelId,
			thinkingLevel: summary.thinkingLevel,
			leafId: summary.leafId,
			status: "idle" as const,
		}));
		return {
			items: page,
			nextCursor: start + page.length < sorted.length ? String(start + page.length) : null,
			diagnostics: result.diagnostics,
		};
	}

	rebuild(directory: string) {
		return this.codec.scan(directory);
	}
}

export { sessionHandle };
