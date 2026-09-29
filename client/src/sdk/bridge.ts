import type { CadViewer } from './CadViewer'

/**
 * postMessage API for the iframe embed (embed.html). The host page talks to the viewer with
 *   iframe.contentWindow.postMessage({ channel: 'cad-viewer', id: 1, method: 'select', args: ['Engine_Block'] }, origin)
 * and receives { channel, id, result | error } replies plus { channel, event, data } notifications.
 * public/sdk/cad-viewer-host.js wraps this in a promise-based helper.
 */
export const CHANNEL = 'cad-viewer'

/** Only these methods can be called from the host page. */
const METHODS = new Set([
  'load', 'openFromSource', 'clear', 'cancel', 'fit', 'setView', 'setProjection', 'setUpAxis', 'setDisplayMode',
  'setSection', 'setExplode', 'setGrid', 'setFlyMode', 'setQuality', 'getTree', 'getParts', 'find', 'select',
  'getSelection', 'zoomTo', 'show', 'hide', 'isolate', 'showAll', 'colorize', 'resetColors', 'setTool',
  'getMeasurements', 'clearMeasurements', 'getStats', 'screenshot', 'listSources', 'listModels',
])
const EVENTS = ['loadstart', 'progress', 'load', 'error', 'select', 'visibility', 'measure', 'clear'] as const

export interface BridgeOptions {
  /** Origins allowed to control the viewer. ['*'] allows any (development only). */
  allowedOrigins: string[]
  /** Receives auth headers sent by the host with the 'setHeaders' call (kept in memory only). */
  onHeaders: (h: Record<string, string>) => void
}

export function startBridge(viewer: CadViewer, opts: BridgeOptions) {
  const parent = window.parent
  if (!parent || parent === window) return () => {}
  let hostOrigin: string | null = null
  const allowed = (origin: string) => opts.allowedOrigins.includes('*') || opts.allowedOrigins.includes(origin)

  const post = (msg: Record<string, unknown>, origin = hostOrigin) => {
    if (origin) parent.postMessage({ channel: CHANNEL, ...msg }, origin)
  }

  const onMessage = async (ev: MessageEvent) => {
    const msg = ev.data
    if (ev.source !== parent || !msg || msg.channel !== CHANNEL) return
    if (!allowed(ev.origin)) {
      console.warn(`[cad-viewer] rejected message from ${ev.origin} (not in allowed embed origins)`)
      return
    }
    hostOrigin = ev.origin // events go only to the origin that talked to us
    const { id, method, args = [] } = msg as { id?: number; method: string; args?: unknown[] }
    try {
      let result: unknown
      if (method === 'hello') result = { version: 1, methods: [...METHODS], events: EVENTS }
      else if (method === 'setHeaders') opts.onHeaders((args[0] as Record<string, string>) ?? {})
      else if (METHODS.has(method)) result = await (viewer as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args)
      else throw new Error(`Unknown method: ${method}`)
      if (id !== undefined) post({ id, result: toCloneable(result) }, ev.origin)
    } catch (e) {
      if (id !== undefined) post({ id, error: (e as Error).message ?? String(e) }, ev.origin)
    }
  }
  window.addEventListener('message', onMessage)
  const offs = EVENTS.map((name) => viewer.on(name, (data) => post({ event: name, data: toCloneable(data) })))
  // Tell the parent we exist. No data in it, so '*' is safe; the host answers with 'hello'.
  parent.postMessage({ channel: CHANNEL, event: 'ready' }, '*')
  return () => {
    window.removeEventListener('message', onMessage)
    offs.forEach((o) => o())
  }
}

/** Strips anything postMessage cannot clone (functions, class instances with methods). */
function toCloneable(v: unknown): unknown {
  if (v === undefined || v === null || typeof v !== 'object') return v
  if (v instanceof Blob || v instanceof ArrayBuffer) return v
  return JSON.parse(JSON.stringify(v))
}
