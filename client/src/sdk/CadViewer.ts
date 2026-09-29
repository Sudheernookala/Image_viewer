import { Viewer, type Axis, type DisplayMode, type ModelStats, type SectionState, type SelectionInfo, type TreeNode, type ViewName } from '../viewer/Viewer'
import { cancelLoading, loadModelFile, setDracoDecoderPath, setEngineBaseUrl, sniffExtension, warmUpCadKernel, type LoadedModel, type Quality } from '../loaders/loadModel'
import { FORMATS, extOf } from '../loaders/formats'
import { splitFiles } from '../lib/files'
import { saveLocal } from '../lib/localDb'
import * as api from '../lib/serverApi'

/** Anything the viewer can open. */
export type ModelInput =
  | File
  | Blob
  | ArrayBuffer
  | string // URL
  | {
      url?: string
      data?: Blob | ArrayBuffer
      /** File name incl. extension. Needed when the URL has none (format is sniffed otherwise). */
      name?: string
      /** Extra request headers for this URL, e.g. { Authorization: 'Bearer …' } */
      headers?: Record<string, string>
      /** Free-form data echoed back in the `load` event, e.g. { itemId: 'PRT-1001', revision: 'B' } */
      meta?: Record<string, unknown>
    }

export interface CadViewerConfig {
  /** Base URL of the viewer server (API + engine files). Default: same origin, or the SDK script's origin. */
  serverUrl?: string
  /** Where occt-worker.js / occt-import-js.wasm live. Default: `${serverUrl}/engine/`. */
  engineUrl?: string
  /** glTF Draco decoder location (self-host it on air-gapped networks). */
  dracoDecoderUrl?: string
  /** Tessellation quality for STEP/IGES. */
  quality?: Quality
  /** Headers sent with every URL / server request. A function is called per request (token refresh). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
  /** Send cookies with URL requests (PLM single sign-on sessions). */
  withCredentials?: boolean
  /** Cache opened files in this browser (IndexedDB). Off by default: controlled PLM data should not linger on clients. */
  rememberRecent?: boolean
}

export interface LoadResult {
  stats: ModelStats
  meta: Record<string, unknown>[]
  failed: string[]
}

export interface PartInfo {
  id: number
  name: string
  path: string
  isMesh: boolean
  visible: boolean
}

/** Parts can be addressed by internal id, exact name, or a glob such as "Wheel_*". */
export type PartQuery = number | string | (number | string)[]

export interface CadViewerEvents {
  ready: void
  loadstart: { count: number }
  progress: { message: string }
  load: LoadResult
  error: { message: string }
  select: { part: SelectionInfo | null }
  visibility: void
  measure: { measurements: { id: number; distance: number }[] }
  clear: void
}
type Handler<K extends keyof CadViewerEvents> = (data: CadViewerEvents[K]) => void

/**
 * Framework-independent viewer API. Everything the built-in UI does goes through this class,
 * so a host application (PLM portal, MES, web shop, Angular/React app…) can do the same.
 */
export class CadViewer {
  readonly engine: Viewer
  readonly config: CadViewerConfig
  private handlers = new Map<string, Set<(d: unknown) => void>>()
  private files: File[] = []
  private unsub: () => void
  loading = false

  constructor(container: HTMLElement, config: CadViewerConfig = {}) {
    this.config = { quality: 'normal', rememberRecent: false, ...config }
    if (config.engineUrl || config.serverUrl) setEngineBaseUrl(config.engineUrl ?? joinUrl(config.serverUrl!, 'engine/'))
    if (config.dracoDecoderUrl) setDracoDecoderPath(config.dracoDecoderUrl)
    api.setServerUrl(config.serverUrl ?? '')
    api.setHeaderProvider(() => this.headers())
    this.engine = new Viewer(container)
    this.unsub = this.engine.subscribe((e) => {
      if (e === 'selection') this.emit('select', { part: this.engine.getSelectionInfo() })
      if (e === 'tree') this.emit('visibility', undefined)
      if (e === 'measure') this.emit('measure', { measurements: this.getMeasurements() })
    })
    warmUpCadKernel()
    queueMicrotask(() => this.emit('ready', undefined))
  }

  // ------------------------------------------------------------- events

  on<K extends keyof CadViewerEvents>(event: K, fn: Handler<K>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(fn as (d: unknown) => void)
    return () => this.off(event, fn)
  }
  off<K extends keyof CadViewerEvents>(event: K, fn: Handler<K>) {
    this.handlers.get(event)?.delete(fn as (d: unknown) => void)
  }
  private emit<K extends keyof CadViewerEvents>(event: K, data: CadViewerEvents[K]) {
    this.handlers.get(event)?.forEach((h) => {
      try {
        h(data)
      } catch (e) {
        console.error(e)
      }
    })
  }

  // ------------------------------------------------------------- loading

  /** Opens one or more models. `replace: false` adds them to the current scene (assemblies from several files). */
  async load(input: ModelInput | ModelInput[], opts: { replace?: boolean } = {}): Promise<LoadResult> {
    const replace = opts.replace ?? true
    const inputs = Array.isArray(input) ? input : [input]
    this.loading = true
    this.emit('loadstart', { count: inputs.length })
    const meta: Record<string, unknown>[] = []
    try {
      const files: File[] = []
      for (const i of inputs) {
        const { file, meta: m } = await this.resolve(i)
        files.push(file)
        if (m) meta.push(m)
      }
      return await this.loadFiles(files, replace, meta)
    } catch (e) {
      const message = (e as Error).message
      if (message !== 'Cancelled') this.emit('error', { message })
      throw e
    } finally {
      this.loading = false
    }
  }

  private async loadFiles(all: File[], replace: boolean, meta: Record<string, unknown>[]): Promise<LoadResult> {
    const { models, resources, ignored } = splitFiles(all)
    if (!models.length) {
      throw new Error(`No supported 3D file found${ignored.length ? ` (${ignored.map((f) => f.name).join(', ')})` : ''}.`)
    }
    const loaded: LoadedModel[] = []
    const failed: string[] = []
    for (const f of models) {
      try {
        loaded.push(await loadModelFile(f, resources, this.config.quality!, (message) => this.emit('progress', { message })))
      } catch (e) {
        if ((e as Error).message === 'Cancelled') throw e
        failed.push(`${f.name}: ${(e as Error).message}`)
      }
    }
    if (!loaded.length) throw new Error(failed.join('\n'))
    this.emit('progress', { message: 'Building scene…' })
    await new Promise((r) => setTimeout(r, 0))
    this.engine.setModels(loaded, replace)
    this.files = replace ? models : [...this.files, ...models]
    if (this.config.rememberRecent) {
      for (const m of models) {
        const companions = [...resources.values()].filter((r) => r !== m && !models.includes(r))
        saveLocal([m, ...companions]).catch(() => {})
      }
    }
    const result = { stats: this.engine.getStats(), meta, failed }
    if (failed.length) this.emit('error', { message: failed.join('\n') })
    this.emit('load', result)
    return result
  }

  private async resolve(i: ModelInput): Promise<{ file: File; meta?: Record<string, unknown> }> {
    if (i instanceof File) return { file: await ensureExtension(i) }
    if (i instanceof Blob) return { file: await ensureExtension(new File([i], 'model')) }
    if (i instanceof ArrayBuffer) return { file: await ensureExtension(new File([i], 'model')) }
    if (typeof i === 'string') return { file: await this.fetchFile(i) }
    if (i.data) return { file: await ensureExtension(new File([i.data], i.name ?? 'model')), meta: i.meta }
    if (i.url) return { file: await this.fetchFile(i.url, i.name, i.headers), meta: i.meta }
    throw new Error('Nothing to load: pass a File, Blob, ArrayBuffer, URL or { url | data }')
  }

  private async fetchFile(url: string, name?: string, headers?: Record<string, string>): Promise<File> {
    this.emit('progress', { message: `Downloading ${name ?? url}…` })
    const res = await fetch(url, {
      headers: { ...(await this.headers()), ...headers },
      credentials: this.config.withCredentials ? 'include' : 'same-origin',
    })
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
    const fileName = name ?? filenameFromResponse(res) ?? decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'model')
    const blob = await readWithProgress(res, (p) => this.emit('progress', { message: `Downloading ${fileName}… ${Math.round(p * 100)}%` }))
    return ensureExtension(new File([blob], fileName))
  }

  private async headers(): Promise<Record<string, string>> {
    const h = this.config.headers
    return typeof h === 'function' ? await h() : (h ?? {})
  }

  cancel() {
    cancelLoading()
  }

  clear() {
    this.engine.clearModels()
    this.files = []
    this.emit('clear', undefined)
  }

  /** Files currently open (e.g. to save them somewhere). */
  getFiles(): File[] {
    return [...this.files]
  }

  // ------------------------------------------------------------- server sources (PLM / DB connectors)

  listSources() {
    return api.listSources()
  }
  listModels(source = 'local', q = '') {
    return api.listModels(source, q)
  }
  /** Opens a model straight from a connector, e.g. openFromSource('plm', 'PRT-1001'). */
  async openFromSource(source: string, id: string | number, opts: { replace?: boolean } = {}) {
    const info = await api.getModel(source, id).catch(() => null)
    return this.load({ url: api.fileUrl(source, id), name: info?.name, meta: { source, id, ...(info ?? {}) } }, opts)
  }
  /** Uploads the open files to the viewer database (the "local" source). */
  async saveToServer(category = 'Uploads') {
    for (const f of this.files) await api.upload(f, category)
  }

  // ------------------------------------------------------------- camera & display

  fit() {
    this.engine.fit()
  }
  setView(view: ViewName) {
    this.engine.setView(view)
  }
  setProjection(p: 'perspective' | 'orthographic') {
    this.engine.setProjection(p)
  }
  setUpAxis(up: 'Y' | 'Z') {
    this.engine.setUpAxis(up)
  }
  setDisplayMode(mode: DisplayMode) {
    this.engine.setDisplayMode(mode)
  }
  setSection(axis: Axis, state: Partial<SectionState>) {
    this.engine.setSection(axis, state)
  }
  setExplode(factor: number) {
    this.engine.setExplode(factor)
  }
  setGrid(visible: boolean) {
    this.engine.setGrid(visible)
  }
  setFlyMode(on: boolean) {
    this.engine.setFlyMode(on)
  }
  setQuality(q: Quality) {
    this.config.quality = q
  }

  // ------------------------------------------------------------- parts

  getTree(): TreeNode[] {
    return this.engine.getTree()
  }
  getParts(): PartInfo[] {
    return this.engine.getParts()
  }
  /** Resolves ids / names / globs ("Wheel_*") to part ids. */
  find(query: PartQuery): number[] {
    const qs = Array.isArray(query) ? query : [query]
    const parts = this.getParts()
    const ids = new Set<number>()
    for (const q of qs) {
      if (typeof q === 'number') {
        if (parts.some((p) => p.id === q)) ids.add(q)
        continue
      }
      const re = q.includes('*') || q.includes('?') ? globToRegExp(q) : null
      for (const p of parts) if (re ? re.test(p.name) : p.name === q) ids.add(p.id)
    }
    return [...ids]
  }
  select(query: PartQuery | null) {
    if (query === null) return this.engine.select(null)
    const [id] = this.find(query)
    this.engine.selectById(id ?? null)
  }
  getSelection(): SelectionInfo | null {
    return this.engine.getSelectionInfo()
  }
  zoomTo(query: PartQuery) {
    const ids = this.find(query)
    if (ids.length === 1) this.engine.focus(ids[0])
    else if (ids.length) this.engine.isolateMany(ids)
  }
  show(query: PartQuery) {
    this.find(query).forEach((id) => this.engine.setVisible(id, true))
  }
  hide(query: PartQuery) {
    this.find(query).forEach((id) => this.engine.setVisible(id, false))
  }
  isolate(query: PartQuery) {
    this.engine.isolateMany(this.find(query))
  }
  showAll() {
    this.engine.showAll()
  }
  /** Colour parts, e.g. by PLM lifecycle state: colorize({ 'Engine_*': '#2ecc71', Body_Hood: '#e74c3c' }). */
  colorize(map: Record<string, string>, opacity = 1) {
    const entries: { id: number; color: string; opacity: number }[] = []
    for (const [q, color] of Object.entries(map)) {
      const key: number | string = /^\d+$/.test(q) ? Number(q) : q
      for (const id of this.find(key)) entries.push({ id, color, opacity })
    }
    this.engine.colorize(entries)
  }
  resetColors() {
    this.engine.resetColors()
  }

  // ------------------------------------------------------------- tools & output

  setTool(tool: 'select' | 'measure') {
    this.engine.setTool(tool)
  }
  getMeasurements() {
    return this.engine.measurements.map((m) => ({ id: m.id, distance: m.a.distanceTo(m.b) }))
  }
  clearMeasurements() {
    this.engine.clearMeasurements()
  }
  getStats(): ModelStats | null {
    return this.engine.hasModels() ? this.engine.getStats() : null
  }
  /** PNG data URL of the current view. */
  screenshot(): string {
    return this.engine.screenshot()
  }

  destroy() {
    this.unsub()
    this.engine.dispose()
    this.handlers.clear()
  }
}

// ------------------------------------------------------------- helpers

async function ensureExtension(f: File): Promise<File> {
  if (extOf(f.name) in FORMATS || extOf(f.name) === 'mtl' || extOf(f.name) === 'bin') return f
  const ext = await sniffExtension(f)
  if (!ext) return f
  return new File([f], `${f.name.replace(/\.[^.]*$/, '') || 'model'}.${ext}`, { type: f.type })
}

function filenameFromResponse(res: Response): string | null {
  const cd = res.headers.get('content-disposition')
  if (!cd) return null
  const star = cd.match(/filename\*=(?:UTF-8'')?([^;]+)/i)
  if (star) return decodeURIComponent(star[1].replace(/"/g, ''))
  const plain = cd.match(/filename="?([^";]+)"?/i)
  return plain ? decodeURIComponent(plain[1]) : null
}

async function readWithProgress(res: Response, onProgress: (p: number) => void): Promise<Blob> {
  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || !total) return res.blob()
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let got = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    got += value.length
    onProgress(got / total)
  }
  return new Blob(chunks as BlobPart[])
}

function globToRegExp(g: string) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}

function joinUrl(base: string, path: string) {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}
