import { useCallback, useEffect, useState } from 'react'
import { deleteLocal, listLocal, type LocalEntry } from '../lib/localDb'
import { deleteServer, listServer, type ServerModel } from '../lib/serverApi'
import { formatBytes } from '../lib/files'
import { Icon } from './Icon'

interface Props {
  onOpenServer: (m: ServerModel) => void
  onOpenLocal: (e: LocalEntry) => void
  refreshKey: number
}

export function LibraryPanel({ onOpenServer, onOpenLocal, refreshKey }: Props) {
  const [tab, setTab] = useState<'server' | 'local'>('server')
  const [server, setServer] = useState<ServerModel[]>([])
  const [local, setLocal] = useState<LocalEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const refresh = useCallback(async () => {
    setError(null)
    try {
      setLocal(await listLocal())
    } catch {
      setLocal([])
    }
    try {
      setServer(await listServer(q))
    } catch {
      setServer([])
      setError('Server database not reachable. Start it with "npm run dev" in the project root.')
    }
  }, [q])

  useEffect(() => {
    refresh()
  }, [refresh, refreshKey])

  const groups = server.reduce<Record<string, ServerModel[]>>((acc, m) => {
    ;(acc[m.category || 'Other'] ??= []).push(m)
    return acc
  }, {})

  return (
    <div className="library">
      <div className="tabs small">
        <button className={tab === 'server' ? 'active' : ''} onClick={() => setTab('server')}>
          Server DB ({server.length})
        </button>
        <button className={tab === 'local' ? 'active' : ''} onClick={() => setTab('local')}>
          Recent ({local.length})
        </button>
        <button className="icon-btn" title="Refresh" onClick={refresh}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {tab === 'server' && (
        <>
          <input className="search" placeholder="Search database…" value={q} onChange={(e) => setQ(e.target.value)} />
          {error && <div className="note warn">{error}</div>}
          <div className="lib-scroll">
            {Object.entries(groups).map(([cat, items]) => (
              <div key={cat}>
                <div className="lib-cat">{cat}</div>
                {items.map((m) => (
                  <div key={m.id} className="lib-item" onClick={() => onOpenServer(m)} title={m.description || m.name}>
                    <span className="badge">{m.format}</span>
                    <span className="lib-name">{m.name}</span>
                    <span className="lib-size">{formatBytes(m.size)}</span>
                    <button
                      className="icon-btn"
                      title="Delete from database"
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (confirm(`Delete ${m.name} from the server database?`)) {
                          await deleteServer(m.id)
                          refresh()
                        }
                      }}
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'local' && (
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
