import { resolve } from "node:path";
import type { ConversationIndex, Project } from "@earendil-works/pi-desktop-protocol";
import {
	PiSessionCodec,
	SqliteMetadataRepository,
	createSessionMigrationReport,
	writeSessionMigrationReport,
} from "@earendil-works/pi-desktop-storage";

function usage(): never {
	console.error("Usage: npm run migrate:sessions -- <session-directory> [report.json] [metadata.sqlite]");
	process.exit(2);
}

const directory = process.argv[2];
if (!directory) usage();
const reportPath = resolve(process.argv[3] ?? "session-migration-report.json");
const databasePath = process.argv[4] ? resolve(process.argv[4]) : undefined;
const codec = new PiSessionCodec();
const scan = await codec.scan(resolve(directory));
let projects: Project[] = [];
let conversations: ConversationIndex[] = [];
if (databasePath) {
	const metadata = new SqliteMetadataRepository(databasePath);
	await metadata.initialize();
	projects = await metadata.listProjects();
	for (const project of projects) conversations.push(...(await metadata.listConversations(project.id)));
	await metadata.close();
}
const report = createSessionMigrationReport(projects, conversations, scan);
await writeSessionMigrationReport(reportPath, report);
console.log(JSON.stringify({ reportPath, sessions: report.sessions, diagnostics: report.diagnostics.length }));
