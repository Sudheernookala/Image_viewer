import { useCallback, useEffect, useState } from 'react'
import { deleteLocal, listLocal, type LocalEntry } from '../lib/localDb'
import { listModels, listSources, remove, type ServerModel, type SourceInfo } from '../lib/serverApi'
import { formatBytes } from '../lib/files'
import { Icon } from './Icon'

interface Props {
  onOpenServer: (source: string, m: ServerModel) => void
  onOpenLocal: (e: LocalEntry) => void
  refreshKey: number
  showRecent: boolean
}

/** Browses every model source the server exposes (its own DB + PLM / document connectors). */
export function LibraryPanel({ onOpenServer, onOpenLocal, refreshKey, showRecent }: Props) {
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [source, setSource] = useState<string>('local')
  const [models, setModels] = useState<ServerModel[]>([])
  const [local, setLocal] = useState<LocalEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    listSources()
      .then(setSources)
      .catch(() => setSources([]))
  }, [refreshKey])

  const refresh = useCallback(async () => {
    setError(null)
    if (source === '__recent') {
      setLocal(await listLocal().catch(() => []))
      return
    }
    try {
      setModels(await listModels(source, q))
    } catch (e) {
      setModels([])
      setError(`Cannot reach "${source}": ${(e as Error).message || 'server not running'}`)
    }
  }, [source, q])

  useEffect(() => {
    const t = setTimeout(refresh, q ? 250 : 0) // debounce search
    return () => clearTimeout(t)
  }, [refresh, refreshKey, q])

  const current = sources.find((s) => s.id === source)
  const groups = models.reduce<Record<string, ServerModel[]>>((acc, m) => {
    ;(acc[m.category || 'Other'] ??= []).push(m)
    return acc
  }, {})

  return (
    <div className="library">
      <div className="source-bar">
        <select value={source} onChange={(e) => setSource(e.target.value)} title="Model source">
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          {!sources.length && <option value="local">Viewer database</option>}
          {showRecent && <option value="__recent">Recent (this browser)</option>}
        </select>
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {source !== '__recent' && (
        <>
          <input className="search" placeholder="Search name, part number, state…" value={q} onChange={(e) => setQ(e.target.value)} />
          {error && <div className="note warn">{error}</div>}
          <div className="lib-scroll">
            {Object.entries(groups).map(([cat, items]) => (
              <div key={cat}>
                <div className="lib-cat">{cat}</div>
                {items.map((m) => (
                  <div key={m.id} className="lib-item" onClick={() => onOpenServer(source, m)} title={m.description || m.name}>
                    <span className="badge">{m.format}</span>
                    <span className="lib-name">
                      {m.name}
                      {m.extra && (
                        <span className="lib-meta">
                          {Object.entries(m.extra)
                            .filter(([, v]) => v !== null && v !== undefined && v !== '')
                            .slice(0, 3)
                            .map(([k, v]) => (
                              <span key={k} title={k}>
                                {String(v)}
                              </span>
                            ))}
                        </span>
                      )}
                    </span>
                    <span className="lib-size">{m.size ? formatBytes(m.size) : ''}</span>
                    {current?.canUpload && (
                      <button
                        className="icon-btn"
                        title="Delete from database"
                        onClick={async (e) => {
                          e.stopPropagation()
                          if (confirm(`Delete ${m.name}?`)) {
                            await remove(source, m.id)
                            refresh()
                          }
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {!error && !models.length && <div className="empty">No models found.</div>}
          </div>
        </>
      )}
      {source === '__recent' && (
        <div className="lib-scroll">
          {!local.length && <div className="empty">Files you open are cached here (IndexedDB, this browser only).</div>}
          {local.map((e) => (
            <div key={e.id} className="lib-item" onClick={() => onOpenLocal(e)}>
              <span className="badge">{e.name.split('.').pop()?.toUpperCase()}</span>
              <span className="lib-name">{e.name}</span>
              <span className="lib-size">{formatBytes(e.size)}</span>
              <button
                className="icon-btn"
                title="Remove"
                onClick={async (ev) => {
                  ev.stopPropagation()
                  await deleteLocal(e.id)
                  refresh()
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
