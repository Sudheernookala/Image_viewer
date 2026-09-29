// Model library server: metadata in SQLite (node:sqlite, built into Node >= 22.13),
// file contents on disk (streams large CAD files without loading them into memory).
//
//   GET    /api/models?q=         list / search
//   GET    /api/models/:id/file   download (streamed)
//   POST   /api/models?name=&category=&description=   upload (raw body)
//   DELETE /api/models/:id
//
// Also serves the built client (client/dist) so production is a single process.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data')
const FILES = path.join(DATA, 'files')
const DIST = path.join(ROOT, '..', 'client', 'dist')
const SAMPLES = path.join(ROOT, '..', 'samples')
const PORT = Number(process.env.PORT) || 3001
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 1024) * 1024 * 1024
const MODEL_EXTS = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', '3mf', 'amf', 'ply', 'obj', 'gltf', 'glb', 'fbx', 'dae', '3ds', 'wrl', 'vrml', 'vtk', 'vtp', 'pcd', 'xyz', 'lwo', 'usdz', 'off'])

fs.mkdirSync(FILES, { recursive: true })
const db = new DatabaseSync(path.join(DATA, 'models.db'))
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

const ext = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '')
const insert = db.prepare('INSERT INTO models (name, format, size, category, description) VALUES (?, ?, ?, ?, ?)')
const byId = db.prepare('SELECT * FROM models WHERE id = ?')

function addFile(src, name, category, description) {
  const size = fs.statSync(src).size
  const { lastInsertRowid } = insert.run(name, ext(name).toUpperCase(), size, category, description)
  fs.copyFileSync(src, path.join(FILES, String(lastInsertRowid)))
  return byId.get(lastInsertRowid)
}

// Seed with the generated sample car on first run.
if (db.prepare('SELECT COUNT(*) AS n FROM models').get().n === 0 && fs.existsSync(SAMPLES)) {
  const walk = (dir, category) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name)
      if (f.isDirectory()) walk(p, 'Car parts')
      else if (MODEL_EXTS.has(ext(f.name))) addFile(p, f.name, category, `Sample ${ext(f.name).toUpperCase()} file`)
    }
  }
  walk(SAMPLES, 'Sample car (full assembly)')
  console.log('Seeded database from', SAMPLES)
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' }

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const p = url.pathname
  try {
    if (p === '/api/health') return json(res, 200, { ok: true })

    if (p === '/api/models' && req.method === 'GET') {
      const q = `%${url.searchParams.get('q') || ''}%`
      const rows = db
        .prepare(
          `SELECT * FROM models WHERE name LIKE ? OR category LIKE ? OR description LIKE ?
           ORDER BY CASE WHEN category LIKE 'Sample%' THEN 0 WHEN category = 'Uploads' THEN 2 ELSE 1 END, category, name`,
        )
        .all(q, q, q)
      return json(res, 200, rows)
    }

    if (p === '/api/models' && req.method === 'POST') {
      const name = path.basename(url.searchParams.get('name') || '')
      if (!MODEL_EXTS.has(ext(name))) return json(res, 400, { error: 'Unsupported or missing file name' })
      const len = Number(req.headers['content-length'] || 0)
      if (len > MAX_UPLOAD) return json(res, 413, { error: 'File too large' })
      const tmp = path.join(FILES, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      await pipeline(req, fs.createWriteStream(tmp))
      try {
        const row = addFile(tmp, name, url.searchParams.get('category') || 'Uploads', url.searchParams.get('description') || '')
        return json(res, 201, row)
      } finally {
        fs.rmSync(tmp, { force: true })
      }
    }

    const m = p.match(/^\/api\/models\/(\d+)(\/file)?$/)
    if (m) {
      const row = byId.get(Number(m[1]))
      if (!row) return json(res, 404, { error: 'Not found' })
      const file = path.join(FILES, String(row.id))
      if (m[2] && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fs.statSync(file).size,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(row.name)}"`,
          'Cache-Control': 'private, max-age=3600',
        })
        return void (await pipeline(fs.createReadStream(file), res))
      }
      if (!m[2] && req.method === 'GET') return json(res, 200, row)
      if (!m[2] && req.method === 'DELETE') {
        db.prepare('DELETE FROM models WHERE id = ?').run(row.id)
        fs.rmSync(file, { force: true })
        return json(res, 200, { ok: true })
      }
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found' })

    // static client (production build)
    let f = path.normalize(path.join(DIST, decodeURIComponent(p)))
    if (!f.startsWith(DIST)) return json(res, 403, { error: 'Forbidden' })
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html')
    if (!fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('API is running. Build the client (npm run build) or use the Vite dev server on :5173.')
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  } catch (e) {
    console.error(e)
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) })
    else res.destroy()
  }
})

server.listen(PORT, () => console.log(`Model DB server on http://localhost:${PORT}`))
