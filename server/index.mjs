// CAD viewer server
//  - Model sources: the built-in database ("local") plus connectors to PLM / document systems (sources.json)
//  - Proxies file downloads so PLM credentials stay on the server
//  - Serves the viewer app, the iframe embed page, the SDK script and the examples
//
//   GET    /api/config                                  embed origins + source ids
//   GET    /api/sources                                 configured sources
//   GET    /api/sources/:source/models?q=               list / search
//   GET    /api/sources/:source/models/:id              one model's metadata
//   GET    /api/sources/:source/models/:id/file         download (streamed)
//   POST   /api/sources/local/models?name=&category=    upload (raw body)
//   DELETE /api/sources/local/models/:id
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createLocalConnector } from './connectors/local.mjs'
import { createRestConnector } from './connectors/rest.mjs'
import { expandEnv, MODEL_EXTS, ext } from './connectors/util.mjs'
import { createMockPlm } from './mock-plm.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, '..', 'client', 'dist')
const EXAMPLES = path.join(ROOT, '..', 'examples')
const SAMPLES = path.join(ROOT, '..', 'samples')
const PORT = Number(process.env.PORT) || 3001
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data')
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 1024) * 1024 * 1024
const MOCK_PLM = process.env.MOCK_PLM !== '0'
process.env.PLM_TOKEN ??= 'demo-token'
process.env.SELF_URL ??= `http://localhost:${PORT}`
const list = (v, dflt) => (v ?? dflt).split(',').map((s) => s.trim()).filter(Boolean)
/** Browser origins allowed to call the API / load the SDK (CORS). */
const ALLOWED_ORIGINS = list(process.env.ALLOWED_ORIGINS, '*')
/** Origins allowed to put embed.html in an iframe and drive it with postMessage. */
const EMBED_ORIGINS = list(process.env.EMBED_ORIGINS, '*')

// ---------------------------------------------------------------- sources

const sources = new Map()
const local = createLocalConnector({ dataDir: DATA, seedDir: SAMPLES })
sources.set(local.id, local)

const sourcesFile = process.env.SOURCES_FILE || [path.join(ROOT, 'sources.json'), MOCK_PLM && path.join(ROOT, 'sources.example.json')].find((p) => p && fs.existsSync(p))
if (sourcesFile) {
  for (const cfg of expandEnv(JSON.parse(fs.readFileSync(sourcesFile, 'utf8')))) {
    if (cfg.type === 'rest') sources.set(cfg.id, createRestConnector(cfg))
    // Custom code: a module whose default export is (config) => connector with list/get/open.
    else if (cfg.type === 'module') {
      const mod = await import(new URL(cfg.module, `file://${path.dirname(path.resolve(sourcesFile))}/`).href)
      sources.set(cfg.id, { type: 'module', canUpload: false, ...(await mod.default(cfg)), id: cfg.id, name: cfg.name })
    } else console.warn(`Unknown connector type "${cfg.type}" for source "${cfg.id}"`)
  }
  console.log(`Sources from ${path.basename(sourcesFile)}:`, [...sources.keys()].join(', '))
}
const mockPlm = MOCK_PLM ? createMockPlm({ samplesDir: SAMPLES, token: process.env.PLM_TOKEN }) : null

// ---------------------------------------------------------------- http helpers

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.md': 'text/plain; charset=utf-8',
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function cors(req, res) {
  const origin = req.headers.origin
  if (!origin) return
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length')
  }
}

function serveStatic(res, baseDir, rel, fallback) {
  let f = path.normalize(path.join(baseDir, rel))
  if (!f.startsWith(baseDir)) return json(res, 403, { error: 'Forbidden' })
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    const idx = path.join(f, 'index.html')
    f = fs.existsSync(idx) ? idx : fallback
  }
  if (!f || !fs.existsSync(f)) return json(res, 404, { error: 'Not found' })
  const headers = { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }
  if (f.endsWith('.html')) {
    // Only the embed page may be framed by other sites (and only by EMBED_ORIGINS).
    const embed = path.basename(f) === 'embed.html'
    headers['Content-Security-Policy'] = `frame-ancestors ${embed ? (EMBED_ORIGINS.includes('*') ? '*' : EMBED_ORIGINS.join(' ')) : "'self'"}`
    headers['Cache-Control'] = 'no-cache'
  } else if (rel.includes('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  res.writeHead(200, headers)
  fs.createReadStream(f).pipe(res)
}

function source(id) {
  const s = sources.get(id)
  if (!s) throw Object.assign(new Error(`Unknown source "${id}"`), { status: 404 })
  return s
}

// ---------------------------------------------------------------- routes

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api\/models/, '/api/sources/local/models') // v1 path alias
  if (p === '/api/health') return json(res, 200, { ok: true })
  if (p === '/api/config') return json(res, 200, { embedOrigins: EMBED_ORIGINS, sources: [...sources.keys()] })
  if (p === '/api/sources') {
    return json(res, 200, [...sources.values()].map((s) => ({ id: s.id, name: s.name, type: s.type, canUpload: !!s.canUpload })))
  }
  const m = p.match(/^\/api\/sources\/([^/]+)\/models(?:\/([^/]+))?(\/file)?$/)
  if (!m) return json(res, 404, { error: 'Not found' })
  const src = source(decodeURIComponent(m[1]))
  const id = m[2] && decodeURIComponent(m[2])

  if (!id && req.method === 'GET') return json(res, 200, await src.list({ q: url.searchParams.get('q') ?? '', req }))

  if (!id && req.method === 'POST') {
    if (!src.upload) return json(res, 405, { error: `Source "${src.id}" is read-only` })
    const name = path.basename(url.searchParams.get('name') || '')
    if (!MODEL_EXTS.has(ext(name))) return json(res, 400, { error: 'Unsupported or missing file name' })
    if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) return json(res, 413, { error: 'File too large' })
    const tmp = path.join(DATA, `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await pipeline(req, fs.createWriteStream(tmp))
    try {
      const row = await src.upload(name, tmp, { category: url.searchParams.get('category') || 'Uploads', description: url.searchParams.get('description') || '' })
      return json(res, 201, row)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  if (id && m[3] && req.method === 'GET') {
    const file = await src.open(id, { req })
    if (!file) return json(res, 404, { error: 'Not found' })
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'private, max-age=300',
    }
    if (file.size) headers['Content-Length'] = file.size
    res.writeHead(200, headers)
    return void (await pipeline(file.stream, res))
  }

  if (id && req.method === 'GET') {
    const row = await src.get(id, { req })
    return row ? json(res, 200, row) : json(res, 404, { error: 'Not found' })
  }

  if (id && req.method === 'DELETE') {
    if (!src.remove) return json(res, 405, { error: `Source "${src.id}" is read-only` })
    await src.remove(id)
    return json(res, 200, { ok: true })
  }
  return json(res, 405, { error: 'Method not allowed' })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  try {
    cors(req, res)
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    if (mockPlm && mockPlm(req, res, url)) return
    if (url.pathname.startsWith('/api/')) return await api(req, res, url)
    if (url.pathname.startsWith('/examples')) return serveStatic(res, EXAMPLES, decodeURIComponent(url.pathname.slice('/examples'.length)) || '/', null)
    if (!fs.existsSync(DIST)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('API is running. Build the client (npm run build) or use the Vite dev server on :5173.')
    }
    serveStatic(res, DIST, decodeURIComponent(url.pathname), path.join(DIST, 'index.html'))
  } catch (e) {
    const status = e.status ?? 500
    if (status >= 500) console.error(e)
    if (!res.headersSent) json(res, status, { error: String(e.message || e) })
    else res.destroy()
  }
})

server.listen(PORT, () => console.log(`CAD viewer server on http://localhost:${PORT}  (examples: /examples/)`))
