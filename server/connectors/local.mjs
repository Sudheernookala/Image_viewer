// Built-in model database: metadata in SQLite (node:sqlite), file contents on disk.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ext, MODEL_EXTS } from './util.mjs'

export function createLocalConnector({ id = 'local', name = 'Viewer database', dataDir, seedDir }) {
  const FILES = path.join(dataDir, 'files')
  fs.mkdirSync(FILES, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'models.db'))
  db.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      format      TEXT NOT NULL,
      size        INTEGER NOT NULL,
      category    TEXT NOT NULL DEFAULT 'Uploads',
      description TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);
  `)
  const insert = db.prepare('INSERT INTO models (name, format, size, category, description) VALUES (?, ?, ?, ?, ?)')
  const byId = db.prepare('SELECT * FROM models WHERE id = ?')

  function addFile(src, fileName, category, description) {
    const size = fs.statSync(src).size
    const { lastInsertRowid } = insert.run(fileName, ext(fileName).toUpperCase(), size, category, description)
    fs.copyFileSync(src, path.join(FILES, String(lastInsertRowid)))
    return byId.get(lastInsertRowid)
  }

  // Seed with the generated sample car on first run.
  if (seedDir && db.prepare('SELECT COUNT(*) AS n FROM models').get().n === 0 && fs.existsSync(seedDir)) {
    const walk = (dir, category) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name)
        if (f.isDirectory()) walk(p, 'Car parts')
        else if (MODEL_EXTS.has(ext(f.name))) addFile(p, f.name, category, `Sample ${ext(f.name).toUpperCase()} file`)
      }
    }
    walk(seedDir, 'Sample car (full assembly)')
    console.log('Seeded database from', seedDir)
  }

  return {
    id,
    name,
    type: 'local',
    canUpload: true,
    async list({ q = '' }) {
      const like = `%${q}%`
      return db
        .prepare(
          `SELECT * FROM models WHERE name LIKE ? OR category LIKE ? OR description LIKE ?
           ORDER BY CASE WHEN category LIKE 'Sample%' THEN 0 WHEN category = 'Uploads' THEN 2 ELSE 1 END, category, name`,
        )
        .all(like, like, like)
    },
    async get(modelId) {
      return byId.get(Number(modelId)) ?? null
    },
    async open(modelId) {
      const row = byId.get(Number(modelId))
      if (!row) return null
      const file = path.join(FILES, String(row.id))
      return { name: row.name, size: fs.statSync(file).size, stream: fs.createReadStream(file) }
    },
    async upload(fileName, tmpPath, { category = 'Uploads', description = '' }) {
      return addFile(tmpPath, fileName, category, description)
    },
    async remove(modelId) {
      db.prepare('DELETE FROM models WHERE id = ?').run(Number(modelId))
      fs.rmSync(path.join(FILES, String(Number(modelId))), { force: true })
    },
  }
}
