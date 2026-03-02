import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryDocument } from "./types";

Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");

export class MemoryStore {
	private db: Database;

	constructor(dbPath: string) {
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.db = new Database(dbPath);
		this.loadVecExtension();
	}

	private loadVecExtension(): void {
		const execDir = dirname(process.execPath);
		const devPath = join(
			import.meta.dir,
			"../../node_modules/sqlite-vec-darwin-arm64/vec0.dylib",
		);
		const prodPath = join(execDir, "vec0.dylib");

		const extensionPath = existsSync(devPath) ? devPath : prodPath;
		this.db.loadExtension(extensionPath.replace(/\.dylib$/, ""));
	}

	initialize(dimensions: number): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS memories (
				id TEXT PRIMARY KEY,
				situation TEXT NOT NULL,
				lesson TEXT NOT NULL,
				file_extension TEXT NOT NULL,
				project_name TEXT,
				file TEXT NOT NULL,
				severity TEXT NOT NULL,
				created_at TEXT NOT NULL
			)
		`);

		this.db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
				id TEXT PRIMARY KEY,
				embedding float[${dimensions}]
			)
		`);
	}

	insert(doc: MemoryDocument): void {
		const insertMemory = this.db.prepare(`
			INSERT INTO memories (id, situation, lesson, file_extension, project_name, file, severity, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const insertVec = this.db.prepare(`
			INSERT INTO memories_vec (id, embedding)
			VALUES (?, ?)
		`);

		const transaction = this.db.transaction(() => {
			insertMemory.run(
				doc.id,
				doc.situation,
				doc.lesson,
				doc.fileExtension,
				doc.projectName,
				doc.file,
				doc.severity,
				doc.createdAt,
			);
			insertVec.run(doc.id, new Uint8Array(doc.embedding.buffer));
		});

		transaction();
	}

	close(): void {
		this.db.close();
	}
}
