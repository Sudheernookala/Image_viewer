import { useCallback, useEffect, useRef, useState } from 'react'
import type { Axis, DisplayMode, ModelStats, SectionState, SelectionInfo, TreeNode, ViewName } from './viewer/Viewer'
import type { Quality } from './loaders/loadModel'
import { ACCEPT, SUPPORTED_LIST } from './loaders/formats'
import { filesFromDrop } from './lib/files'
import type { LocalEntry } from './lib/localDb'
import type { ServerModel } from './lib/serverApi'
import { CadViewer, type CadViewerConfig, type ModelInput } from './sdk/CadViewer'
import { ModelTree } from './components/ModelTree'
import { LibraryPanel } from './components/LibraryPanel'
import { SketchOverlay, type SketchHandle } from './components/SketchOverlay'
import { Icon } from './components/Icon'

type Loading = { msg: string; t0: number } | null

/** Which parts of the UI to show. Embedding hosts usually want less chrome than the standalone app. */
export interface UiOptions {
  toolbar?: boolean
  /** Left panel: parts tree and library */
  tree?: boolean
  library?: boolean
  /** Right panel: model info, selection, section, explode, measurements */
  properties?: boolean
  /** Open / Add / Save-to-DB buttons and drag & drop */
  fileActions?: boolean
  upload?: boolean
  title?: string
  /** Shortcuts work anywhere on the page (standalone app). Off when embedded: only while the viewer has focus. */
  globalKeys?: boolean
}

export const UI_PRESETS: Record<'full' | 'compact' | 'minimal' | 'none', UiOptions> = {
  full: { toolbar: true, tree: true, library: true, properties: true, fileActions: true, upload: true },
  compact: { toolbar: true, tree: true, library: false, properties: false, fileActions: false, upload: false },
  minimal: { toolbar: true, tree: false, library: false, properties: false, fileActions: false, upload: false },
  none: { toolbar: false, tree: false, library: false, properties: false, fileActions: false, upload: false },
}

export interface AppProps {
  config?: CadViewerConfig
  ui?: UiOptions
  /** Opened once the viewer is ready. */
  initial?: ModelInput | { source: string; id: string } | null
  onReady?: (viewer: CadViewer) => void
}

export default function App({ config, ui = UI_PRESETS.full, initial, onReady }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<CadViewer | null>(null)
  const sketchRef = useRef<SketchHandle>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const addInput = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState<Loading>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [stats, setStats] = useState<ModelStats | null>(null)
  const [, setMeasureTick] = useState(0)
  const [leftTab, setLeftTab] = useState<'tree' | 'library'>(ui.library ? 'library' : 'tree')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const showLeft = !!(ui.tree || ui.library)
  const [display, setDisplay] = useState<DisplayMode>('shaded')
  const [projection, setProjection] = useState<'perspective' | 'orthographic'>('perspective')
  const [upAxis, setUpAxis] = useState<'Y' | 'Z'>('Z')
  const [grid, setGrid] = useState(true)
  const [quality, setQuality] = useState<Quality>('normal')
  const [tool, setTool] = useState<'select' | 'measure'>('select')
  const [sketching, setSketching] = useState(false)
  const [sketchCount, setSketchCount] = useState(0)
  const [fly, setFly] = useState(false)
  const [section, setSection] = useState<Record<Axis, SectionState>>({
    x: { enabled: false, t: 0.5, flip: false },
    y: { enabled: false, t: 0.5, flip: false },
    z: { enabled: false, t: 0.5, flip: false },
  })
  const [explode, setExplode] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [fileCount, setFileCount] = useState(0)
  const [libKey, setLibKey] = useState(0)
  const [showHelp, setShowHelp] = useState(false)

  // ---------- viewer lifecycle ----------
  useEffect(() => {
    const c = new CadViewer(hostRef.current!, config)
    viewerRef.current = c
    const v = c.engine
    const t0 = { v: 0, n: 0 }
    const offs = [
      v.subscribe((e) => {
        if (e === 'tree') setTree(v.getTree())
        if (e === 'stats') setStats(v.hasModels() ? v.getStats() : null)
        if (e === 'selection') setSelection(v.getSelectionInfo())
        if (e === 'measure') setMeasureTick((n) => n + 1)
      }),
      c.on('loadstart', ({ count }) => {
        t0.v = performance.now()
        t0.n = count
        setError(null)
        setElapsed(0)
        setLoading({ msg: 'Reading files…', t0: t0.v })
      }),
      c.on('progress', ({ message }) => setLoading({ msg: message, t0: t0.v })),
      c.on('load', () => {
        setLoading(null)
        setUpAxis(v.upAxis)
        setExplode(0)
        if (ui.tree) setLeftTab('tree')
        setFileCount(c.getFiles().length)
        setLibKey((k) => k + 1)
        flash(`Loaded ${t0.n} file${t0.n > 1 ? 's' : ''} in ${((performance.now() - t0.v) / 1000).toFixed(2)} s`)
      }),
      c.on('error', ({ message }) => {
        setLoading(null)
        setError(message)
      }),
      c.on('clear', () => setFileCount(0)),
    ]
    onReady?.(c)
    if (initial) {
      const i = initial as { source?: string; id?: string }
      ;(i.source && i.id ? c.openFromSource(i.source, i.id) : c.load(initial as ModelInput)).catch(() => {})
    }
    return () => {
      offs.forEach((o) => o())
      c.destroy()
      viewerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!loading) return
    const t = setInterval(() => setElapsed((performance.now() - loading.t0) / 1000), 100)
    return () => clearInterval(t)
  }, [loading])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500)
  }

  // ---------- loading ----------
  const openFiles = useCallback((files: File[], replace: boolean) => {
    const c = viewerRef.current
    if (!c) return
    c.load(files, { replace }).catch((e) => {
      if ((e as Error).message.startsWith('No supported')) setError(`${(e as Error).message}\nSupported: ${SUPPORTED_LIST}`)
    })
  }, [])

  const openServer = (source: string, m: ServerModel) => viewerRef.current?.openFromSource(source, m.id).catch(() => {})
  const openLocal = (e: LocalEntry) => openFiles(e.files, true)

  const saveToServer = async () => {
    const c = viewerRef.current
    if (!c || !fileCount) return
    try {
      await c.saveToServer()
      setLibKey((k) => k + 1)
      flash(`Saved ${fileCount} file(s) to the server database`)
    } catch (e) {
      setError('Upload failed: ' + (e as Error).message)
    }
  }

  // ---------- drag & drop ----------
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (!ui.fileActions) return
    const files = await filesFromDrop(e.dataTransfer)
    openFiles(files, !e.shiftKey)
  }

  // ---------- tool helpers ----------
  const v = () => viewerRef.current!.engine
  const changeDisplay = (m: DisplayMode) => (setDisplay(m), v().setDisplayMode(m))
  const changeSection = (axis: Axis, s: Partial<SectionState>) => {
    setSection((prev) => ({ ...prev, [axis]: { ...prev[axis], ...s } }))
    v().setSection(axis, s)
  }
  const changeTool = (t: 'select' | 'measure') => {
    setTool(t)
    v().setTool(t)
  }
  const toggleFly = () => {
    const on = !fly
    setFly(on)
    v().setFlyMode(on)
    if (on) flash('Fly mode: W/A/S/D move, Q/E down/up, Shift = fast, drag = look, wheel = forward/back')
  }
  const screenshot = () => {
    const url = v().screenshot(sketchCount ? sketchRef.current?.canvas : null)
    const a = document.createElement('a')
    a.href = url
    a.download = (stats?.files[0]?.name.replace(/\.[^.]+$/, '') || 'view') + '.png'
    a.click()
  }
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen())

  // ---------- keyboard shortcuts (only while the viewer has focus: never hijack the host app) ----------
  const onKey = (e: KeyboardEvent | React.KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const vw = viewerRef.current?.engine
      if (!vw) return
      if (e.key === 'Escape') {
        vw.select(null)
        changeTool('select')
        setSketching(false)
        if (fly) toggleFly()
        return
      }
      if (fly) return // WASD etc. belong to fly mode
      const k = e.key.toLowerCase()
      const views: Record<string, ViewName> = { '1': 'front', '2': 'back', '3': 'left', '4': 'right', '5': 'top', '6': 'bottom', '0': 'iso' }
      if (views[k]) vw.setView(views[k])
      else if (k === 'f') vw.selected ? vw.focus() : vw.fit()
      else if (k === 'h') vw.hideSelected()
      else if (k === 'i') vw.isolate()
      else if (k === 'a') vw.showAll()
      else if (k === 'm') changeTool(tool === 'measure' ? 'select' : 'measure')
      else if (k === 'w') changeDisplay(display === 'wireframe' ? 'shaded' : 'wireframe')
      else if (k === 'e') changeDisplay(display === 'edges' ? 'shaded' : 'edges')
      else if (k === 'x') changeDisplay(display === 'xray' ? 'shaded' : 'xray')
      else if (k === '?') setShowHelp((s) => !s)
  }

  const onKeyRef = useRef(onKey)
  onKeyRef.current = onKey
  useEffect(() => {
    if (!ui.globalKeys) return
    const h = (e: KeyboardEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onKeyRef.current(e)
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [ui.globalKeys])

  const measurements = viewerRef.current?.engine.measurements ?? []
  const hasModel = !!stats

  return (
    <div className="app" ref={rootRef} tabIndex={-1} onKeyDown={onKey}>
      {/* ---------------- toolbar ---------------- */}
      {ui.toolbar && (
      <header className="toolbar">
        <div className="brand">
          <Icon name="cube" size={20} /> <span>{ui.title ?? 'CAD 3D Viewer'}</span>
        </div>
        {ui.fileActions && (
        <div className="group">
          <button className="primary" onClick={() => fileInput.current?.click()} title="Open files (replaces scene)">
            <Icon name="open" /> Open
          </button>
          <button onClick={() => addInput.current?.click()} disabled={!hasModel} title="Add files to the current scene">
            <Icon name="plus" /> Add
          </button>
          {ui.upload && (
            <button onClick={saveToServer} disabled={!fileCount} title="Save the open file(s) to the server database">
              <Icon name="upload" /> Save to DB
            </button>
          )}
          <select
            value={quality}
            onChange={(e) => {
              setQuality(e.target.value as Quality)
              viewerRef.current?.setQuality(e.target.value as Quality)
            }}
            title="STEP/IGES tessellation quality (applies to next load)"
          >
            <option value="draft">Draft mesh (fastest)</option>
            <option value="normal">Normal mesh</option>
            <option value="fine">Fine mesh (slowest)</option>
          </select>
        </div>
        )}
        <div className="group">
          {(
            [
              ['shaded', 'cube', 'Shaded'],
              ['edges', 'edges', 'Shaded + edges (E)'],
              ['wireframe', 'wire', 'Wireframe (W)'],
              ['xray', 'xray', 'X-ray / transparent (X)'],
            ] as [DisplayMode, string, string][]
          ).map(([m, icon, title]) => (
            <button key={m} className={'icon' + (display === m ? ' active' : '')} onClick={() => changeDisplay(m)} title={title}>
              <Icon name={icon} />
            </button>
          ))}
        </div>
        <div className="group">
          <button className={'icon' + (tool === 'select' && !sketching && !fly ? ' active' : '')} onClick={() => changeTool('select')} title="Select parts (click)">
            <Icon name="cursor" />
          </button>
          <button className={'icon' + (tool === 'measure' ? ' active' : '')} onClick={() => changeTool(tool === 'measure' ? 'select' : 'measure')} title="Measure distance (M)">
            <Icon name="ruler" />
          </button>
          <button className={'icon' + (sketching ? ' active' : '')} onClick={() => setSketching(!sketching)} title="Sketch / markup">
            <Icon name="pen" />
          </button>
          <button className={'icon' + (fly ? ' active' : '')} onClick={toggleFly} title="Fly / walk inside (WASD)">
            <Icon name="fly" />
          </button>
        </div>
        <div className="group">
          <button
            className="icon"
            onClick={() => {
              const p = projection === 'perspective' ? 'orthographic' : 'perspective'
              setProjection(p)
              v().setProjection(p)
            }}
            title={`Projection: ${projection}`}
          >
            <Icon name={projection === 'perspective' ? 'persp' : 'ortho'} />
          </button>
          <button
            className="text-btn"
            onClick={() => {
              const u = upAxis === 'Z' ? 'Y' : 'Z'
              setUpAxis(u)
              v().setUpAxis(u)
            }}
            title="Which model axis points up"
          >
            {upAxis}-up
          </button>
          <button className={'icon' + (grid ? ' active' : '')} onClick={() => (setGrid(!grid), v().setGrid(!grid))} title="Grid">
            <Icon name="grid" />
          </button>
          <button className="icon" onClick={screenshot} disabled={!hasModel} title="Screenshot (PNG, includes markup)">
            <Icon name="camera" />
          </button>
          <button className="icon" onClick={fullscreen} title="Full screen">
            <Icon name="full" />
          </button>
          <button className="icon" onClick={() => setShowHelp(!showHelp)} title="Controls & shortcuts (?)">
            <Icon name="help" />
          </button>
        </div>
      </header>
      )}

      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (openFiles([...(e.target.files ?? [])], true), (e.target.value = ''))} />
      <input ref={addInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (openFiles([...(e.target.files ?? [])], false), (e.target.value = ''))} />

      <main className="body">
        {/* ---------------- left panel ---------------- */}
        {showLeft && (
        <aside className={'panel left' + (leftOpen ? '' : ' closed')}>
          {ui.tree && ui.library && (
          <div className="tabs">
            <button className={leftTab === 'tree' ? 'active' : ''} onClick={() => setLeftTab('tree')}>
              <Icon name="tree" size={15} /> Parts
            </button>
            <button className={leftTab === 'library' ? 'active' : ''} onClick={() => setLeftTab('library')}>
              <Icon name="db" size={15} /> Library
            </button>
          </div>
          )}
          {leftTab === 'tree' || !ui.library ? (
            <ModelTree
              tree={tree}
              selectedId={selection?.id ?? null}
              onSelect={(id) => v().selectById(id)}
              onToggle={(id, vis) => v().setVisible(id, vis)}
              onFocus={(id) => v().focus(id)}
              onIsolate={(id) => v().isolate(id)}
            />
          ) : (
            <LibraryPanel onOpenServer={openServer} onOpenLocal={openLocal} refreshKey={libKey} showRecent={!!config?.rememberRecent} />
          )}
        </aside>
        )}
        {showLeft && (
        <button className="collapse left" onClick={() => setLeftOpen(!leftOpen)} title="Toggle panel">
          {leftOpen ? '‹' : '›'}
        </button>
        )}

        {/* ---------------- viewport ---------------- */}
        <section
          className={'viewport' + (dragOver ? ' drag' : '')}
          onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
          onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
          onDrop={onDrop}
        >
          <div ref={hostRef} className="canvas-host" />
          <SketchOverlay ref={sketchRef} active={sketching} onClose={() => setSketching(false)} onChange={setSketchCount} />

          {!hasModel && !loading && ui.fileActions && (
            <div className="welcome">
              <Icon name="cube" size={54} />
              <h2>Drop 3D files or folders here</h2>
              <p>
                STEP, IGES, STL, OBJ, glTF, FBX, 3MF, PLY and more. <br />
                {ui.library && (
                  <>
                    Or pick a model from the <b>Library</b> on the left.
                  </>
                )}
              </p>
              <button className="primary" onClick={() => fileInput.current?.click()}>
                <Icon name="open" /> Browse files
              </button>
            </div>
          )}

          {dragOver && <div className="drop-hint">Release to open · hold Shift to add to scene</div>}

          {hasModel && (
            <div className="views">
              {(['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as ViewName[]).map((n) => (
                <button key={n} onClick={() => v().setView(n)}>
                  {n[0].toUpperCase() + n.slice(1)}
                </button>
              ))}
              <button onClick={() => v().fit()} title="Fit all (F)">
                <Icon name="fit" size={15} />
              </button>
            </div>
          )}

          {tool === 'measure' && <div className="hint">Click two points on the model to measure. Corners snap. Esc to exit.</div>}
          {sketchCount > 0 && !sketching && (
            <button className="hint clickable" onClick={() => sketchRef.current?.clear()}>
              Markup is 2D and does not follow the camera · click to clear
            </button>
          )}

          {loading && (
            <div className="loading">
              <div className="spinner" />
              <div>
                <div>{loading.msg}</div>
                <small>{elapsed.toFixed(1)} s</small>
              </div>
              <button onClick={() => (viewerRef.current?.cancel(), setLoading(null))}>Cancel</button>
            </div>
          )}
          {error && (
            <div className="error" onClick={() => setError(null)}>
              <pre>{error}</pre>
              <small>click to dismiss</small>
            </div>
          )}
          {toast && <div className="toast">{toast}</div>}
          {showHelp && <HelpCard onClose={() => setShowHelp(false)} />}
        </section>

        {ui.properties && (
        <button className="collapse right" onClick={() => setRightOpen(!rightOpen)} title="Toggle panel">
          {rightOpen ? '›' : '‹'}
        </button>
        )}
        {/* ---------------- right panel ---------------- */}
        {ui.properties && (
        <aside className={'panel right' + (rightOpen ? '' : ' closed')}>
          {stats ? (
            <>
              <Section title="Model">
                {stats.files.map((f) => (
                  <div key={f.name} className="kv">
                    <span title={f.name}>{f.name}</span>
                    <b>
                      {f.format} · {(f.parseMs / 1000).toFixed(2)} s
                    </b>
                  </div>
                ))}
                <div className="kv">
                  <span>Parts</span>
                  <b>{stats.meshes.toLocaleString()}</b>
                </div>
                <div className="kv">
                  <span>Triangles</span>
                  <b>{stats.triangles.toLocaleString()}</b>
                </div>
                <div className="kv">
                  <span>Size X×Y×Z</span>
                  <b>
                    {stats.size.map((s) => s.toFixed(1)).join(' × ')} {stats.units === 'mm' ? 'mm' : ''}
                  </b>
                </div>
              </Section>

              <Section title="Selected part">
                {selection ? (
                  <>
                    <div className="sel-name">{selection.name}</div>
                    {selection.path && <div className="sel-path">{selection.path}</div>}
                    <div className="kv">
                      <span>Triangles</span>
                      <b>{selection.triangles.toLocaleString()}</b>
                    </div>
                    <div className="kv">
                      <span>Size</span>
                      <b>{selection.size.map((s) => s.toFixed(1)).join(' × ')}</b>
                    </div>
                    {selection.color && (
                      <div className="kv">
                        <span>Color</span>
                        <b>
                          <i className="dot" style={{ background: selection.color }} /> {selection.color}
                        </b>
                      </div>
                    )}
                    <div className="btn-row">
                      <button onClick={() => v().focus()}>Zoom to</button>
                      <button onClick={() => v().isolate()}>Isolate</button>
                      <button onClick={() => v().hideSelected()}>Hide</button>
                    </div>
                  </>
                ) : (
                  <div className="muted">Click a part in the view or the tree.</div>
                )}
                <div className="btn-row">
                  <button onClick={() => v().showAll()}>Show all</button>
                </div>
              </Section>

              <Section title="Section / cut planes">
                {(['x', 'y', 'z'] as Axis[]).map((a) => (
                  <div key={a} className="section-row">
                    <label>
                      <input type="checkbox" checked={section[a].enabled} onChange={(e) => changeSection(a, { enabled: e.target.checked })} />
                      {a.toUpperCase()}
                    </label>
                    <input type="range" min={0} max={1} step={0.001} value={section[a].t} disabled={!section[a].enabled} onChange={(e) => changeSection(a, { t: +e.target.value })} />
                    <button className="small" disabled={!section[a].enabled} onClick={() => changeSection(a, { flip: !section[a].flip })} title="Flip side">
                      ⇄
                    </button>
                  </div>
                ))}
                <div className="muted">Cut open the model to see inside. Orange = inside faces.</div>
              </Section>

              <Section title="Explode">
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.005}
                  value={explode}
                  onChange={(e) => {
                    setExplode(+e.target.value)
                    v().setExplode(+e.target.value)
                  }}
                />
              </Section>

              <Section title={`Measurements (${measurements.length})`}>
                {measurements.map((m, i) => {
                  const d = v().measurementDelta(m.a, m.b)
                  return (
                    <div key={m.id} className="measure-row">
                      <span>#{i + 1}</span>
                      <b>{v().formatLength(m.a.distanceTo(m.b))}</b>
                      <small>
                        Δ {d.map((x) => x.toFixed(1)).join(' / ')}
                      </small>
                      <button className="icon-btn" onClick={() => v().removeMeasurement(m.id)}>
                        <Icon name="x" size={12} />
                      </button>
                    </div>
                  )
                })}
                <div className="btn-row">
                  <button onClick={() => changeTool(tool === 'measure' ? 'select' : 'measure')}>{tool === 'measure' ? 'Stop measuring' : 'Measure'}</button>
                  {measurements.length > 0 && <button onClick={() => v().clearMeasurements()}>Clear</button>}
                </div>
              </Section>
            </>
          ) : (
            <div className="empty">
              Open a model to see its details.
              <br />
              <br />
              Files are parsed locally in your browser. They only go to the server if you click “Save to DB”.
            </div>
          )}
        </aside>
        )}
      </main>
    </div>
  )
}

/** Shortcuts stay active on sliders/checkboxes; only text entry fields swallow key presses. */
function isTextField(t: EventTarget | null) {
  const el = t as HTMLElement | null
  if (!el) return false
  if (el.tagName === 'TEXTAREA' || el.isContentEditable || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && !['checkbox', 'range', 'radio', 'button'].includes((el as HTMLInputElement).type)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="psection">
      <div className="psection-title" onClick={() => setOpen(!open)}>
        <span className={'twisty' + (open ? ' open' : '')}>
          <Icon name="chevron" size={12} />
        </span>
        {title}
      </div>
      {open && <div className="psection-body">{children}</div>}
    </div>
  )
}

function HelpCard({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Left drag', 'Rotate'],
    ['Right drag / Shift+drag', 'Pan'],
    ['Wheel', 'Zoom toward cursor (go inside)'],
    ['Double-click', 'Set rotation centre on a point'],
    ['Click', 'Select part'],
    ['F', 'Fit all / zoom to selection'],
    ['1–6, 0', 'Front, back, left, right, top, bottom, iso'],
    ['H / I / A', 'Hide / isolate / show all'],
    ['E / W / X', 'Edges / wireframe / x-ray'],
    ['M', 'Measure'],
    ['Fly mode', 'WASD move, Q/E down/up, Shift fast'],
    ['Esc', 'Clear selection, exit tools'],
  ]
  return (
    <div className="help" onClick={onClose}>
      <h3>Controls</h3>
      {rows.map(([k, d]) => (
        <div key={k} className="kv">
          <span>{k}</span>
          <b>{d}</b>
        </div>
      ))}
    </div>
  )
}
