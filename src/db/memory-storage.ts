import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";

// Common Homebrew paths (adjust version if needed):
// Intel Macs: "/usr/local/opt/sqlite/lib/libsqlite3.dylib"
// Apple Silicon: "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"
Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");

const execPath = process.execPath;
const execDir = dirname(execPath);

const db = new Database(join(execDir, "database.sqlite"));

db.loadExtension(join(execDir, "vec0"));

// Verify it works
const result = db.prepare("select vec_version() as vec_version;").get();
console.log(`vec_version=${JSON.stringify(result)}`);

export class MemoryStorage {
	private db;

	constructor(databasePath?: string) {
		if (databasePath) {
			this.db = new Database(databasePath);
			return;
		}

		const execPath = process.execPath;
		const execDir = dirname(execPath);

		this.db = new Database(join(execDir, "database.sqlite"));
	}
}
