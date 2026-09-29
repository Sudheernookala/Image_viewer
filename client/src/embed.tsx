import { createRoot } from 'react-dom/client'
import './index.css'
import App, { UI_PRESETS } from './App.tsx'
import { startBridge } from './sdk/bridge'
import { initialFromParams } from './sdk/params'
import type { CadViewer } from './sdk/CadViewer'

/*
 * iframe embed for tools that cannot load our JavaScript (PLM portals, SharePoint, Confluence, MES screens…).
 *   <iframe src="https://viewer.example.com/embed.html?source=plm&id=PRT-1001&ui=compact"></iframe>
 * Params: ui=full|compact|minimal|none, url | source+id, name, title,
 *         auth=host (wait for the host to send auth headers via postMessage before loading).
 */
const p = new URLSearchParams(location.search)
const preset = (p.get('ui') ?? 'compact') as keyof typeof UI_PRESETS
const ui = { ...(UI_PRESETS[preset] ?? UI_PRESETS.compact), title: p.get('title') ?? undefined }
const initial = initialFromParams(p)
const waitForAuth = p.get('auth') === 'host'

let headers: Record<string, string> = {}

async function boot() {
  // Which host origins may drive this viewer is decided by the server (EMBED_ORIGINS), never by URL params.
  const cfg: { embedOrigins: string[] } = await fetch('api/config')
    .then((r) => r.json())
    .catch(() => ({ embedOrigins: [] }))

  const onReady = (viewer: CadViewer) => {
    let first = true
    startBridge(viewer, {
      allowedOrigins: cfg.embedOrigins,
      onHeaders: (h) => {
        headers = h
        if (first && waitForAuth && initial) {
          first = false
          const i = initial as { source?: string; id?: string }
          ;(i.source && i.id ? viewer.openFromSource(i.source, i.id) : viewer.load(initial as never)).catch(() => {})
        }
      },
    })
  }

  createRoot(document.getElementById('root')!).render(
    <App config={{ headers: () => headers, rememberRecent: false }} ui={ui} initial={waitForAuth ? null : initial} onReady={onReady} />,
  )
}
boot()
