import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Icon } from './Icon'

export type SketchTool = 'pen' | 'line' | 'arrow' | 'rect' | 'circle' | 'text'
type Shape = { tool: SketchTool; color: string; width: number; pts: [number, number][]; text?: string }

export interface SketchHandle {
  canvas: HTMLCanvasElement | null
  clear: () => void
  hasContent: () => boolean
}

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff', '#111111']

/** 2D markup / redline layer drawn over the 3D view (camera is locked while sketching). */
export const SketchOverlay = forwardRef<SketchHandle, { active: boolean; onClose: () => void; onChange: (n: number) => void }>(
  function SketchOverlay({ active, onClose, onChange }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const [shapes, setShapes] = useState<Shape[]>([])
    const [tool, setTool] = useState<SketchTool>('pen')
    const [color, setColor] = useState(COLORS[0])
    const [width, setWidth] = useState(3)
    const drawing = useRef<Shape | null>(null)
    const [, force] = useState(0)

    useImperativeHandle(ref, () => ({
      canvas: canvasRef.current,
      clear: () => setShapes([]),
      hasContent: () => shapes.length > 0,
    }))

    useEffect(() => onChange(shapes.length), [shapes, onChange])

    // redraw
    useEffect(() => {
      const c = canvasRef.current!
      const draw = () => {
        const dpr = window.devicePixelRatio || 1
        const { clientWidth: w, clientHeight: h } = c
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
          c.width = Math.round(w * dpr)
          c.height = Math.round(h * dpr)
        }
        const ctx = c.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, w, h)
        for (const s of drawing.current ? [...shapes, drawing.current] : shapes) paint(ctx, s)
      }
      draw()
      const ro = new ResizeObserver(draw)
      ro.observe(c)
      return () => ro.disconnect()
    })

    const pos = (e: React.PointerEvent): [number, number] => {
      const r = canvasRef.current!.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top]
    }

    const down = (e: React.PointerEvent) => {
      if (!active) return
      const p = pos(e)
      if (tool === 'text') {
        const text = prompt('Note text:')
        if (text) setShapes((s) => [...s, { tool, color, width, pts: [p], text }])
        return
      }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      drawing.current = { tool, color, width, pts: [p, p] }
      force((n) => n + 1)
    }
    const move = (e: React.PointerEvent) => {
      const d = drawing.current
      if (!d) return
      const p = pos(e)
      if (d.tool === 'pen') d.pts.push(p)
      else d.pts[1] = p
      force((n) => n + 1)
    }
    const up = () => {
      const d = drawing.current
      drawing.current = null
      if (d) setShapes((s) => [...s, d])
    }

    return (
      <>
        <canvas
          ref={canvasRef}
          className="sketch-canvas"
          style={{ pointerEvents: active ? 'auto' : 'none', cursor: active ? 'crosshair' : 'default' }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
        />
        {active && (
          <div className="sketch-bar">
            {(['pen', 'line', 'arrow', 'rect', 'circle', 'text'] as SketchTool[]).map((t) => (
              <button key={t} className={tool === t ? 'active' : ''} title={t} onClick={() => setTool(t)}>
                <Icon name={t} size={16} />
              </button>
            ))}
            <span className="sep" />
            {COLORS.map((c) => (
              <button key={c} className={'swatch' + (c === color ? ' active' : '')} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
            <span className="sep" />
            <input type="range" min={1} max={12} value={width} onChange={(e) => setWidth(+e.target.value)} title="Stroke width" />
            <button title="Undo" onClick={() => setShapes((s) => s.slice(0, -1))}>
              <Icon name="undo" size={16} />
            </button>
            <button title="Clear" onClick={() => setShapes([])}>
              <Icon name="trash" size={16} />
            </button>
            <button title="Done (keeps markup visible)" onClick={onClose}>
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
      </>
    )
  },
)

function paint(ctx: CanvasRenderingContext2D, s: Shape) {
  ctx.strokeStyle = ctx.fillStyle = s.color
  ctx.lineWidth = s.width
  ctx.lineCap = ctx.lineJoin = 'round'
  const [a, b] = s.pts
  ctx.beginPath()
  switch (s.tool) {
    case 'pen':
      s.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.stroke()
      break
    case 'line':
    case 'arrow': {
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
      ctx.stroke()
      if (s.tool === 'arrow') {
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
        const l = 10 + s.width * 3
        ctx.beginPath()
        ctx.moveTo(b[0], b[1])
        ctx.lineTo(b[0] - l * Math.cos(ang - 0.45), b[1] - l * Math.sin(ang - 0.45))
        ctx.lineTo(b[0] - l * Math.cos(ang + 0.45), b[1] - l * Math.sin(ang + 0.45))
        ctx.closePath()
        ctx.fill()
      }
      break
    }
    case 'rect':
      ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1])
      break
    case 'circle':
      ctx.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
      break
    case 'text': {
      ctx.font = `600 ${12 + s.width * 2}px system-ui, sans-serif`
      const m = ctx.measureText(s.text!)
      ctx.fillStyle = 'rgba(0,0,0,0.55)'
      ctx.fillRect(a[0] - 4, a[1] - 14 - s.width * 2, m.width + 8, 20 + s.width * 2)
      ctx.fillStyle = s.color
      ctx.fillText(s.text!, a[0], a[1])
      break
    }
  }
}
