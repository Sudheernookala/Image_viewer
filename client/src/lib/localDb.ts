// Browser-side model library stored in IndexedDB (persists across reloads, no server needed).
export interface LocalEntry {
  id: number
  name: string
  size: number
  addedAt: number
  files: File[] // model + companion files (mtl, textures, bin...)
}

const DB = 'cad-viewer'
const STORE = 'models'
const MAX_ENTRIES = 25

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction(STORE, mode).objectStore(STORE))
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      }),
  )
}

export async function listLocal(): Promise<LocalEntry[]> {
  const all = await tx<LocalEntry[]>('readonly', (s) => s.getAll())
  return all.sort((a, b) => b.addedAt - a.addedAt)
}

export async function saveLocal(files: File[]): Promise<void> {
  const main = files[0]
  const existing = await listLocal()
  // replace older copy with the same name, and cap the library size
  for (const e of existing) if (e.name === main.name) await deleteLocal(e.id)
  const keep = existing.filter((e) => e.name !== main.name)
  for (const e of keep.slice(MAX_ENTRIES - 1)) await deleteLocal(e.id)
  await tx('readwrite', (s) =>
    s.add({ name: main.name, size: files.reduce((n, f) => n + f.size, 0), addedAt: Date.now(), files }),
  )
}

export function deleteLocal(id: number): Promise<undefined> {
  return tx('readwrite', (s) => s.delete(id))
}
