// Generic REST / OData connector. Most PLM and document systems (Windchill REST Services, Teamcenter
// Active Workspace REST, Aras Innovator OData, 3DEXPERIENCE, Arena, SharePoint, custom DBs) expose
// "search items" and "download file" endpoints; this connector maps them with configuration only.
import { Readable } from 'node:stream'
import { ext, fillUrl, pick } from './util.mjs'

/**
 * config: {
 *   id, name, baseUrl,
 *   list:  { url: "{baseUrl}/parts?search={q}", itemsPath: "items" },
 *   item:  { url: "{baseUrl}/parts/{id}" }            // optional
 *   file:  { url: "{baseUrl}/parts/{id}/content", nameHeader: true },
 *   fields: { id, name, size, category, description } // dot-paths into each item
 *   extra:  { partNumber: "number", revision: "revision", state: "state" }
 *   headers: { Authorization: "Bearer ${PLM_TOKEN}" }, // service account (env vars expanded)
 *   forwardAuth: false                                 // true: pass the user's Authorization/Cookie through
 * }
 */
export function createRestConnector(config) {
  const f = { id: 'id', name: 'name', size: 'size', category: 'category', description: 'description', ...config.fields }
  const vars = (extra) => ({ baseUrl: (config.baseUrl ?? '').replace(/\/+$/, ''), ...extra })

  const headersFor = (req) => {
    const h = { Accept: 'application/json', ...(config.headers ?? {}) }
    if (config.forwardAuth && req) {
      if (req.headers.authorization) h.Authorization = req.headers.authorization
      if (req.headers.cookie) h.Cookie = req.headers.cookie
    }
    return h
  }

  const call = async (url, req) => {
    const r = await fetch(url, { headers: headersFor(req), signal: AbortSignal.timeout(config.timeoutMs ?? 30000) })
    if (!r.ok) {
      const err = new Error(`${config.name}: HTTP ${r.status} from ${new URL(url).pathname}`)
      err.status = r.status === 401 || r.status === 403 ? r.status : 502
      throw err
    }
    return r
  }

  const map = (item) => {
    const name = String(pick(item, f.name) ?? pick(item, f.id))
    return {
      id: String(pick(item, f.id)),
      name,
      format: ext(name).toUpperCase() || '?',
      size: Number(pick(item, f.size) ?? 0),
      category: String(pick(item, f.category) ?? ''),
      description: String(pick(item, f.description) ?? ''),
      extra: Object.fromEntries(Object.entries(config.extra ?? {}).map(([k, p]) => [k, pick(item, p) ?? null])),
    }
  }

  return {
    id: config.id,
    name: config.name,
    type: 'rest',
    canUpload: false,
    async list({ q = '', req }) {
      const r = await call(fillUrl(config.list.url, vars({ q })), req)
      const body = await r.json()
      const items = config.list.itemsPath ? pick(body, config.list.itemsPath) : body
      return (Array.isArray(items) ? items : []).map(map)
    },
    async get(id, { req } = {}) {
      if (!config.item?.url) return (await this.list({ q: id, req })).find((m) => m.id === String(id)) ?? null
      const r = await call(fillUrl(config.item.url, vars({ id })), req).catch((e) => {
        if (e.status === 502) return null
        throw e
      })
      return r ? map(await r.json()) : null
    },
    async open(id, { req } = {}) {
      const r = await call(fillUrl(config.file.url, vars({ id })), req)
      const cd = r.headers.get('content-disposition') ?? ''
      const fromHeader = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1]
      const name = fromHeader ? decodeURIComponent(fromHeader) : ((await this.get(id, { req }).catch(() => null))?.name ?? `${id}`)
      return { name, size: Number(r.headers.get('content-length')) || undefined, stream: Readable.fromWeb(r.body) }
    },
  }
}
