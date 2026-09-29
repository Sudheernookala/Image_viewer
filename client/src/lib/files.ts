import { extOf, isModelFile, RESOURCE_EXTS } from '../loaders/formats'

/** Reads dropped files, including whole folders (recursively). */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = [...dt.items]
    .map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null))
    .filter(Boolean) as FileSystemEntry[]
  if (!entries.length) return [...dt.files]
  const out: File[] = []
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) {
      out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)))
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej))
        if (!batch.length) break
        await Promise.all(batch.map(walk))
      }
    }
  }
  await Promise.all(entries.map(walk))
  return out
}

/** Splits a file list into loadable models and companion resources (mtl/bin/textures). */
export function splitFiles(files: File[]) {
  const models = files.filter((f) => isModelFile(f.name))
  const resources = new Map<string, File>()
  for (const f of files) if (RESOURCE_EXTS.has(extOf(f.name)) || isModelFile(f.name)) resources.set(f.name.toLowerCase(), f)
  const ignored = files.filter((f) => !isModelFile(f.name) && !RESOURCE_EXTS.has(extOf(f.name)))
  return { models, resources, ignored }
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}
