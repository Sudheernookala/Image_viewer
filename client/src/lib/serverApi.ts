// Server-side model library (Node + SQLite). See /server.
export interface ServerModel {
  id: number
  name: string
  format: string
  size: number
  category: string
  description: string
  created_at: string
}

export async function listServer(q = ''): Promise<ServerModel[]> {
  const r = await fetch('/api/models' + (q ? `?q=${encodeURIComponent(q)}` : ''))
  if (!r.ok) throw new Error(`Server returned ${r.status}`)
  return r.json()
}

export async function fetchServerFile(m: ServerModel, onProgress?: (pct: number) => void): Promise<File> {
  const r = await fetch(`/api/models/${m.id}/file`)
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status})`)
  const total = Number(r.headers.get('content-length')) || m.size
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress?.(total ? got / total : 0)
  }
  return new File(chunks as BlobPart[], m.name)
}

export async function uploadServer(file: File, category = 'Uploads', description = ''): Promise<ServerModel> {
  const qs = new URLSearchParams({ name: file.name, category, description })
  const r = await fetch('/api/models?' + qs, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
  if (!r.ok) throw new Error((await r.text()) || `Upload failed (${r.status})`)
  return r.json()
}

export async function deleteServer(id: number): Promise<void> {
  const r = await fetch(`/api/models/${id}`, { method: 'DELETE' })
  if (!r.ok) throw new Error(`Delete failed (${r.status})`)
}
