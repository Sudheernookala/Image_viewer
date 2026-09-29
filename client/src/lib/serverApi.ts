// Client for the viewer server. Models come from "sources": the built-in database ("local")
// or connectors configured on the server (PLM systems, document stores, …). See server/connectors.
export interface ServerModel {
  id: string | number
  name: string
  format: string
  size: number
  category: string
  description: string
  created_at?: string
  /** Connector-specific metadata, e.g. { partNumber, revision, state } from a PLM. */
  extra?: Record<string, unknown>
}

export interface SourceInfo {
  id: string
  name: string
  type: string
  canUpload: boolean
}

let serverUrl = ''
let headerProvider: () => Promise<Record<string, string>> = async () => ({})

export function setServerUrl(url: string) {
  serverUrl = url.replace(/\/+$/, '')
}
export function setHeaderProvider(fn: () => Promise<Record<string, string>>) {
  headerProvider = fn
}

const u = (path: string) => serverUrl + path

async function req(path: string, init: RequestInit = {}) {
  const r = await fetch(u(path), { ...init, headers: { ...(await headerProvider()), ...(init.headers as Record<string, string>) } })
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `Server returned ${r.status}`)
  return r
}

export async function listSources(): Promise<SourceInfo[]> {
  return (await req('/api/sources')).json()
}

export async function listModels(source: string, q = ''): Promise<ServerModel[]> {
  return (await req(`/api/sources/${encodeURIComponent(source)}/models${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json()
}

export async function getModel(source: string, id: string | number): Promise<ServerModel> {
  return (await req(`/api/sources/${encodeURIComponent(source)}/models/${encodeURIComponent(String(id))}`)).json()
}

export function fileUrl(source: string, id: string | number) {
  return u(`/api/sources/${encodeURIComponent(source)}/models/${encodeURIComponent(String(id))}/file`)
}

export async function upload(file: File, category = 'Uploads', description = ''): Promise<ServerModel> {
  const qs = new URLSearchParams({ name: file.name, category, description })
  return (await req('/api/sources/local/models?' + qs, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })).json()
}

export async function remove(source: string, id: string | number): Promise<void> {
  await req(`/api/sources/${encodeURIComponent(source)}/models/${encodeURIComponent(String(id))}`, { method: 'DELETE' })
}
