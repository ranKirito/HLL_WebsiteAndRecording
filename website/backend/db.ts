// db.ts
import Database from "better-sqlite3";
import path from "node:path"
import { fileURLToPath } from 'node:url';


//database
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const db = new Database(path.resolve(__dirname, "replay.db"))

//create db if it doesnt exist
db.exec(`
  CREATE TABLE IF NOT EXISTS replays (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    originalname TEXT NOT NULL,
    map TEXT NOT NULL,
    duration INTEGER,
    createdAt TEXT NOT NULL
  )
`)

//type of metadata to be stored
type ReplayMetadata = {
  id: string;
  filename: string;
  originalname: string;
  map: string;
  duration: number;
  created_at: string;
};

//insert metadata of a replay into the database
export function insertReplay(metadata: ReplayMetadata): void {
  const stmt = db.prepare(`INSERT INTO replays (id, filename, originalname, map, duration, createdAt) VALUES (?, ?, ?, ?, ?, ?)`)
  stmt.run(
    metadata.id,
    metadata.filename,
    metadata.originalname,
    metadata.map,
    metadata.duration,
    metadata.created_at
  )
}

export function listReplays() {
  const stmt = db.prepare(`SELECT * FROM replays`)
  return stmt.all()
}

export function getReplayById(id: string): void {
}
