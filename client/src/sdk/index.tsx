/*
 * CAD Viewer SDK — drop-in for any web app (Angular, React, Vue, plain HTML, PLM customisations).
 *
 *   <script type="module" src="https://viewer.example.com/sdk/cad-viewer.js"></script>
 *   <cad-viewer src="https://…/part.step" ui="compact" style="height:600px"></cad-viewer>
 *
 * or programmatically:
 *
 *   import { mountViewer } from 'https://viewer.example.com/sdk/cad-viewer.js'
 *   const viewer = await mountViewer(document.getElementById('box'), { ui: 'minimal' })
 *   await viewer.load({ url: '/plm/files/123', name: 'bracket.step', headers: { Authorization: token } })
 *   viewer.on('select', ({ part }) => showPlmDetails(part?.name))
 */
import { createRoot, type Root } from 'react-dom/client'
import css from '../index.css?inline'
import App, { UI_PRESETS, type UiOptions } from '../App'
import { CadViewer, type CadViewerConfig, type ModelInput } from './CadViewer'

export { CadViewer, UI_PRESETS }
export type { CadViewerConfig, ModelInput, UiOptions }
export type { CadViewerEvents, LoadResult, PartInfo, PartQuery } from './CadViewer'

/** The viewer server this script was loaded from: API and engine files default to it. */
const SCRIPT_URL = import.meta.url
const DEFAULT_SERVER = new URL('..', SCRIPT_URL).href.replace(/\/$/, '')

export interface MountOptions extends CadViewerConfig {
  /** UI preset or custom options. 'none' = bare 3D canvas controlled only through the API. */
  ui?: keyof typeof UI_PRESETS | UiOptions
  /** Model to open immediately. */
  initial?: ModelInput | { source: string; id: string } | null
}

/**
 * Renders the viewer (with the chosen UI) into `element` inside a shadow root, so host-page CSS
 * cannot break it and its CSS cannot leak into the host page. Resolves with the API object.
 */
export function mountViewer(element: HTMLElement, opts: MountOptions = {}): Promise<CadViewer> & { unmount: () => void } {
  const { ui = 'full', initial, ...config } = opts
  const shadow = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
  shadow.innerHTML = `<style>${css}\n:host{display:block;position:relative;min-height:320px}\n.app{height:100%;position:absolute;inset:0}</style><div class="mount" style="position:absolute;inset:0"></div>`
  const root: Root = createRoot(shadow.querySelector('.mount')!)
  const uiOpts = typeof ui === 'string' ? UI_PRESETS[ui] : { ...UI_PRESETS.full, ...ui }
  const p = new Promise<CadViewer>((resolve) => {
    root.render(<App config={{ serverUrl: DEFAULT_SERVER, ...config }} ui={uiOpts} initial={initial} onReady={resolve} />)
  }) as Promise<CadViewer> & { unmount: () => void }
  p.unmount = () => root.unmount()
  return p
}

type HeadersValue = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)

/**
 * <cad-viewer> custom element.
 * Attributes: src, name, source + model-id, ui (full|compact|minimal|none), quality (draft|normal|fine),
 *             server-url, title.
 * Properties: viewer (CadViewer API, after 'cad-ready'), headers (object or function for auth).
 * DOM events: cad-ready, cad-load, cad-select, cad-error, cad-visibility, cad-measure, cad-progress.
 */
export class CadViewerElement extends HTMLElement {
  static observedAttributes = ['src', 'model-id', 'source']
  viewer: CadViewer | null = null
  headers: HeadersValue = {}
  private mounted: ReturnType<typeof mountViewer> | null = null

  connectedCallback() {
    if (this.mounted) return
    const ui = (this.getAttribute('ui') ?? 'compact') as keyof typeof UI_PRESETS
    this.mounted = mountViewer(this, {
      ui: { ...(UI_PRESETS[ui] ?? UI_PRESETS.compact), title: this.getAttribute('title') ?? undefined },
      serverUrl: this.getAttribute('server-url') ?? DEFAULT_SERVER,
      quality: (this.getAttribute('quality') as CadViewerConfig['quality']) ?? 'normal',
      headers: () => (typeof this.headers === 'function' ? this.headers() : this.headers),
      withCredentials: this.hasAttribute('with-credentials'),
    })
    this.mounted.then((v) => {
      this.viewer = v
      for (const ev of ['load', 'select', 'error', 'visibility', 'measure', 'progress', 'loadstart', 'clear'] as const) {
        v.on(ev, (detail) => this.dispatchEvent(new CustomEvent(`cad-${ev}`, { detail, bubbles: true, composed: true })))
      }
      this.dispatchEvent(new CustomEvent('cad-ready', { detail: v, bubbles: true, composed: true }))
      this.loadFromAttributes()
    })
  }

  disconnectedCallback() {
    // Deferred: frameworks often move elements (disconnect + reconnect) during rendering.
    queueMicrotask(() => {
      if (this.isConnected || !this.mounted) return
      this.mounted.unmount()
      this.mounted = null
      this.viewer = null
    })
  }

  attributeChangedCallback(_name: string, oldV: string | null, newV: string | null) {
    if (oldV !== newV && this.viewer) this.loadFromAttributes()
  }

  private loadFromAttributes() {
    const v = this.viewer!
    const source = this.getAttribute('source')
    const id = this.getAttribute('model-id')
    const src = this.getAttribute('src')
    if (source && id) v.openFromSource(source, id).catch(() => {})
    else if (src) v.load({ url: src, name: this.getAttribute('name') ?? undefined }).catch(() => {})
  }

  /** Shortcut for element.viewer.load(...) */
  load(input: ModelInput | ModelInput[], opts?: { replace?: boolean }) {
    if (!this.viewer) throw new Error('cad-viewer is not ready yet; wait for the cad-ready event')
    return this.viewer.load(input, opts)
  }
}

if (!customElements.get('cad-viewer')) customElements.define('cad-viewer', CadViewerElement)
