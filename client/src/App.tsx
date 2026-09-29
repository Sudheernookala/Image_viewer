import { useCallback, useEffect, useRef, useState } from 'react'
import { Viewer, type Axis, type DisplayMode, type ModelStats, type SectionState, type SelectionInfo, type TreeNode, type ViewName } from './viewer/Viewer'
import { cancelLoading, loadModelFile, warmUpCadKernel, type LoadedModel, type Quality } from './loaders/loadModel'
import { ACCEPT, SUPPORTED_LIST } from './loaders/formats'
import { filesFromDrop, splitFiles } from './lib/files'
import { saveLocal, type LocalEntry } from './lib/localDb'
import { fetchServerFile, uploadServer, type ServerModel } from './lib/serverApi'
import { ModelTree } from './components/ModelTree'
import { LibraryPanel } from './components/LibraryPanel'
import { SketchOverlay, type SketchHandle } from './components/SketchOverlay'
import { Icon } from './components/Icon'

type Loading = { msg: string; t0: number } | null

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Viewer | null>(null)
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
  const [leftTab, setLeftTab] = useState<'tree' | 'library'>('library')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
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
  const [currentFiles, setCurrentFiles] = useState<File[]>([])
  const [libKey, setLibKey] = useState(0)
  const [showHelp, setShowHelp] = useState(false)

  // ---------- viewer lifecycle ----------
  useEffect(() => {
    const v = new Viewer(hostRef.current!)
    viewerRef.current = v
    const off = v.subscribe((e) => {
      if (e === 'tree') setTree(v.getTree())
      if (e === 'stats') setStats(v.hasModels() ? v.getStats() : null)
      if (e === 'selection') setSelection(v.getSelectionInfo())
      if (e === 'measure') setMeasureTick((n) => n + 1)
    })
    warmUpCadKernel()
    return () => {
      off()
      v.dispose()
      viewerRef.current = null
    }
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
  const openFiles = useCallback(
    async (files: File[], replace: boolean, remember = true) => {
      const v = viewerRef.current
      if (!v) return
      const { models, resources, ignored } = splitFiles(files)
      if (!models.length) {
        setError(`No supported 3D file found${ignored.length ? ` (got ${ignored.map((f) => f.name).join(', ')})` : ''}.\nSupported: ${SUPPORTED_LIST}`)
        return
      }
      setError(null)
      const t0 = performance.now()
      setElapsed(0)
      setLoading({ msg: 'Reading files…', t0 })
      const loaded: LoadedModel[] = []
      const failed: string[] = []
      for (const f of models) {
        try {
          loaded.push(await loadModelFile(f, resources, quality, (msg) => setLoading({ msg, t0 })))
        } catch (e) {
          const msg = (e as Error).message
          if (msg === 'Cancelled') return setLoading(null)
          failed.push(`${f.name}: ${msg}`)
        }
      }
      setLoading({ msg: 'Building scene…', t0 })
      await new Promise((r) => setTimeout(r, 0))
      if (loaded.length) {
        v.setModels(loaded, replace)
        setUpAxis(v.upAxis)
        setExplode(0)
        setLeftTab('tree')
        setCurrentFiles((prev) => (replace ? models : [...prev, ...models]))
        const ms = performance.now() - t0
        flash(`Loaded ${loaded.length} file${loaded.length > 1 ? 's' : ''} in ${(ms / 1000).toFixed(2)} s`)
        if (remember) {
          for (const m of models) {
            const companions = [...resources.values()].filter((r) => r !== m && !models.includes(r))
            saveLocal([m, ...companions]).then(() => setLibKey((k) => k + 1)).catch(() => {})
          }
        }
      }
      if (failed.length) setError(failed.join('\n'))
      setLoading(null)
    },
    [quality],
  )

  const openServer = async (m: ServerModel) => {
    const t0 = performance.now()
    try {
      setLoading({ msg: `Downloading ${m.name}…`, t0 })
      const f = await fetchServerFile(m, (p) => setLoading({ msg: `Downloading ${m.name}… ${Math.round(p * 100)}%`, t0 }))
      await openFiles([f], true, false)
    } catch (e) {
      setLoading(null)
      setError((e as Error).message)
    }
  }

  const openLocal = (e: LocalEntry) => openFiles(e.files, true, false)

  // ?url=https://…/model.step  → open directly
  useEffect(() => {
    const url = new URLSearchParams(location.search).get('url')
    if (!url) return
    ;(async () => {
      try {
        setLoading({ msg: `Downloading ${url}…`, t0: performance.now() })
        const r = await fetch(url)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'model')
        await openFiles([new File([await r.blob()], name)], true)
      } catch (e) {
        setLoading(null)
        setError(`Could not open ${url}: ${(e as Error).message}`)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const saveToServer = async () => {
    if (!currentFiles.length) return
    try {
      for (const f of currentFiles) await uploadServer(f)
      setLibKey((k) => k + 1)
      flash(`Saved ${currentFiles.length} file(s) to the server database`)
    } catch (e) {
      setError('Upload failed: ' + (e as Error).message)
    }
  }

  // ---------- drag & drop ----------
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = await filesFromDrop(e.dataTransfer)
    openFiles(files, !e.shiftKey)
  }

  // ---------- tool helpers ----------
  const v = () => viewerRef.current!
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
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())

  // ---------- keyboard shortcuts ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
      const vw = viewerRef.current
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
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const measurements = viewerRef.current?.measurements ?? []
  const hasModel = !!stats

  return (
    <div className="app">
      {/* ---------------- toolbar ---------------- */}
      <header className="toolbar">
        <div className="brand">
          <Icon name="cube" size={20} /> <span>CAD 3D Viewer</span>
        </div>
        <div className="group">
          <button className="primary" onClick={() => fileInput.current?.click()} title="Open files (replaces scene)">
            <Icon name="open" /> Open
          </button>
          <button onClick={() => addInput.current?.click()} disabled={!hasModel} title="Add files to the current scene">
            <Icon name="plus" /> Add
          </button>
          <button onClick={saveToServer} disabled={!currentFiles.length} title="Save the open file(s) to the server database">
            <Icon name="upload" /> Save to DB
          </button>
          <select value={quality} onChange={(e) => setQuality(e.target.value as Quality)} title="STEP/IGES tessellation quality (applies to next load)">
            <option value="draft">Draft mesh (fastest)</option>
            <option value="normal">Normal mesh</option>
            <option value="fine">Fine mesh (slowest)</option>
          </select>
        </div>
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

      <input ref={fileInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (openFiles([...(e.target.files ?? [])], true), (e.target.value = ''))} />
      <input ref={addInput} type="file" multiple accept={ACCEPT} hidden onChange={(e) => (openFiles([...(e.target.files ?? [])], false), (e.target.value = ''))} />

      <main className="body">
        {/* ---------------- left panel ---------------- */}
        <aside className={'panel left' + (leftOpen ? '' : ' closed')}>
          <div className="tabs">
            <button className={leftTab === 'tree' ? 'active' : ''} onClick={() => setLeftTab('tree')}>
              <Icon name="tree" size={15} /> Parts
            </button>
            <button className={leftTab === 'library' ? 'active' : ''} onClick={() => setLeftTab('library')}>
              <Icon name="db" size={15} /> Library
            </button>
          </div>
          {leftTab === 'tree' ? (
            <ModelTree
              tree={tree}
              selectedId={selection?.id ?? null}
              onSelect={(id) => v().selectById(id)}
              onToggle={(id, vis) => v().setVisible(id, vis)}
              onFocus={(id) => v().focus(id)}
              onIsolate={(id) => v().isolate(id)}
            />
          ) : (
            <LibraryPanel onOpenServer={openServer} onOpenLocal={openLocal} refreshKey={libKey} />
          )}
        </aside>
        <button className="collapse left" onClick={() => setLeftOpen(!leftOpen)} title="Toggle panel">
          {leftOpen ? '‹' : '›'}
        </button>

        {/* ---------------- viewport ---------------- */}
        <section
          className={'viewport' + (dragOver ? ' drag' : '')}
          onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
          onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
          onDrop={onDrop}
        >
          <div ref={hostRef} className="canvas-host" />
          <SketchOverlay ref={sketchRef} active={sketching} onClose={() => setSketching(false)} onChange={setSketchCount} />

          {!hasModel && !loading && (
            <div className="welcome">
              <Icon name="cube" size={54} />
              <h2>Drop 3D files or folders here</h2>
              <p>
                STEP, IGES, STL, OBJ, glTF, FBX, 3MF, PLY and more. <br />
                Or pick a sample from the <b>Library</b> (server database) on the left.
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
              <button onClick={() => (cancelLoading(), setLoading(null))}>Cancel</button>
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

        <button className="collapse right" onClick={() => setRightOpen(!rightOpen)} title="Toggle panel">
          {rightOpen ? '›' : '‹'}
        </button>
        {/* ---------------- right panel ---------------- */}
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
