import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { LoadedModel } from '../loaders/loadModel'

// BVH-accelerated picking: raycasts against multi-million triangle models stay sub-millisecond.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
THREE.Mesh.prototype.raycast = acceleratedRaycast

export type DisplayMode = 'shaded' | 'edges' | 'wireframe' | 'xray'
export type Tool = 'select' | 'measure'
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'
export type Axis = 'x' | 'y' | 'z'
export interface SectionState {
  enabled: boolean
  /** 0..1 across the model bounding box */
  t: number
  flip: boolean
}
export interface TreeNode {
  id: number
  name: string
  isMesh: boolean
  visible: boolean
  children: TreeNode[]
}
export interface SelectionInfo {
  id: number
  name: string
  path: string
  triangles: number
  vertices: number
  size: [number, number, number]
  color: string | null
}
export interface ModelStats {
  files: { name: string; format: string; parseMs: number }[]
  meshes: number
  triangles: number
  size: [number, number, number]
  units: string
}
export type ViewerEvent = 'selection' | 'tree' | 'stats' | 'measure' | 'status'

const _v = new THREE.Vector3()
const _box = new THREE.Box3()

export class Viewer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  private perspCam: THREE.PerspectiveCamera
  private orthoCam: THREE.OrthographicCamera
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  controls: OrbitControls
  private labelRenderer: CSS2DRenderer
  /** Holds every loaded model. Rotated when switching between Y-up and Z-up. */
  private content = new THREE.Group()
  private helpers = new THREE.Group()
  private grid: THREE.GridHelper | null = null
  private models: LoadedModel[] = []
  private meshes: THREE.Mesh[] = []
  private radius = 1
  private center = new THREE.Vector3()
  private needsRender = true
  private raf = 0
  private listeners = new Set<(e: ViewerEvent) => void>()
  private resizeObs: ResizeObserver
  private timer = new THREE.Timer()

  // display
  displayMode: DisplayMode = 'shaded'
  private edgeMat = new THREE.LineBasicMaterial({ color: 0x1b1f27, transparent: true, opacity: 0.55 })
  private edgesJob = 0
  upAxis: 'Y' | 'Z' = 'Z'
  showGrid = true

  // selection
  tool: Tool = 'select'
  selected: THREE.Mesh | null = null
  private highlightMat = new THREE.MeshStandardMaterial({
    color: 0xff8a1f,
    emissive: 0x662200,
    metalness: 0.1,
    roughness: 0.5,
    side: THREE.DoubleSide,
  })

  // section
  private planes: Record<Axis, THREE.Plane> = {
    x: new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0),
    y: new THREE.Plane(new THREE.Vector3(0, -1, 0), 0),
    z: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  }
  section: Record<Axis, SectionState> = {
    x: { enabled: false, t: 0.5, flip: false },
    y: { enabled: false, t: 0.5, flip: false },
    z: { enabled: false, t: 0.5, flip: false },
  }
  private activePlanes: THREE.Plane[] = []
  private sectionBox = new THREE.Box3()

  // explode
  explode = 0
  private explodeReady = false

  // measure
  measurements: { id: number; a: THREE.Vector3; b: THREE.Vector3; obj: THREE.Object3D }[] = []
  private measureStart: THREE.Vector3 | null = null
  private measureGroup = new THREE.Group()
  private hoverMarker: THREE.Mesh
  private measureId = 0

  // fly
  flyMode = false
  private keys = new Set<string>()

  // interaction
  private downPos: { x: number; y: number } | null = null
  private raycaster = new THREE.Raycaster()
  private basePixelRatio = Math.min(window.devicePixelRatio, 2)

  // axis gizmo
  private gizmoScene = new THREE.Scene()
  private gizmoCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10)

  private container: HTMLElement

  constructor(container: HTMLElement) {
    this.container = container
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(this.basePixelRatio)
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.toneMapping = THREE.NeutralToneMapping
    this.renderer.autoClear = false
    this.renderer.localClippingEnabled = true
    container.appendChild(this.renderer.domElement)

    this.labelRenderer = new CSS2DRenderer()
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    container.appendChild(this.labelRenderer.domElement)

    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.8
    pmrem.dispose()

    this.perspCam = new THREE.PerspectiveCamera(45, 1, 0.1, 10000)
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000)
    this.camera = this.perspCam
    // Headlight follows the camera so the side you look at is always lit (CAD-style lighting).
    for (const cam of [this.perspCam, this.orthoCam]) {
      const head = new THREE.DirectionalLight(0xffffff, 1.2)
      head.position.set(0.5, 1, 1)
      cam.add(head)
      this.scene.add(cam)
    }
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.6))
    this.scene.add(this.content, this.helpers, this.measureGroup)

    this.hoverMarker = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x00e0ff, depthTest: false, transparent: true, opacity: 0.9 }),
    )
    this.hoverMarker.renderOrder = 999
    this.hoverMarker.visible = false
    this.scene.add(this.hoverMarker)

    this.controls = this.makeControls()
    this.buildGizmo()
    this.setUpAxis('Z', false)

    const el = this.renderer.domElement
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('dblclick', this.onDoubleClick)
    el.addEventListener('wheel', this.onWheel, { passive: false })
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)

    this.resizeObs = new ResizeObserver(() => this.resize())
    this.resizeObs.observe(container)
    this.resize()
    this.loop()
  }

  // ------------------------------------------------------------------ events

  subscribe(fn: (e: ViewerEvent) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit(e: ViewerEvent) {
    this.listeners.forEach((l) => l(e))
  }
  requestRender = () => {
    this.needsRender = true
  }

  // ------------------------------------------------------------------ setup

  private makeControls() {
    const c = new OrbitControls(this.camera, this.renderer.domElement)
    c.enableDamping = true
    c.dampingFactor = 0.15
    c.zoomToCursor = true // zoom goes where the mouse points: lets you dive inside assemblies
    c.screenSpacePanning = true
    c.minDistance = 0
    c.addEventListener('change', this.requestRender)
    // Adaptive resolution: drop pixel ratio while moving heavy models, restore when idle.
    c.addEventListener('start', () => {
      if (this.triangleCount() > 1_500_000) this.renderer.setPixelRatio(1)
    })
    c.addEventListener('end', () => {
      this.renderer.setPixelRatio(this.basePixelRatio)
      this.requestRender()
    })
    return c
  }

  private buildGizmo() {
    const mk = (dir: THREE.Vector3, color: number, label: string) => {
      const g = new THREE.Group()
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir]),
        new THREE.LineBasicMaterial({ color }),
      )
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 64
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0')
      ctx.beginPath()
      ctx.arc(32, 32, 26, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.font = 'bold 34px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, 32, 34)
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }))
      sprite.position.copy(dir).multiplyScalar(1.15)
      sprite.scale.setScalar(0.45)
      g.add(line, sprite)
      return g
    }
    this.gizmoAxes = new THREE.Group()
    this.gizmoAxes.add(
      mk(new THREE.Vector3(1, 0, 0), 0xe5484d, 'X'),
      mk(new THREE.Vector3(0, 1, 0), 0x30a46c, 'Y'),
      mk(new THREE.Vector3(0, 0, 1), 0x3e63dd, 'Z'),
    )
    this.gizmoScene.add(this.gizmoAxes)
  }
  private gizmoAxes!: THREE.Group

  private resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h)
    this.labelRenderer.setSize(w, h)
    this.perspCam.aspect = w / h
    this.perspCam.updateProjectionMatrix()
    this.updateOrthoFrustum()
    this.requestRender()
  }

  private updateOrthoFrustum() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    const dist = this.perspCam.position.distanceTo(this.controls?.target ?? new THREE.Vector3())
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2))
    const halfW = (halfH * w) / h
    Object.assign(this.orthoCam, { left: -halfW, right: halfW, top: halfH, bottom: -halfH })
    this.orthoCam.updateProjectionMatrix()
  }

  // ------------------------------------------------------------------ render loop

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop)
    this.timer.update()
    const dt = Math.min(this.timer.getDelta(), 0.1)
    if (this.flyMode && this.keys.size) this.flyStep(dt)
    const moved = this.controls.update()
    if (!moved && !this.needsRender) return // on-demand rendering: idle GPU when nothing changes
    this.needsRender = false
    this.syncOrtho()
    this.updateClipRange()
    this.render()
  }

  private render() {
    const r = this.renderer
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    r.setViewport(0, 0, w, h)
    r.setScissorTest(false)
    r.clear()
    this.scaleMarkers()
    r.render(this.scene, this.camera)
    this.labelRenderer.render(this.scene, this.camera)
    // axis gizmo, bottom-left corner
    const s = 90
    this.gizmoAxes.quaternion.copy(this.camera.quaternion).invert()
    this.gizmoCam.position.set(0, 0, 5)
    r.clearDepth()
    r.setViewport(8, 8, s, s)
    r.render(this.gizmoScene, this.gizmoCam)
  }

  /** Near/far follow the camera so you can fly inside a car without the front clipping away. */
  private updateClipRange() {
    if (this.camera !== this.perspCam) return
    const dist = this.perspCam.position.distanceTo(this.controls.target)
    const r = this.radius
    const near = THREE.MathUtils.clamp(dist * 0.005, r * 1e-4, r * 0.05)
    const far = this.perspCam.position.distanceTo(this.center) + r * 6
    if (Math.abs(near - this.perspCam.near) > 1e-9 || Math.abs(far - this.perspCam.far) > 1e-6) {
      this.perspCam.near = near
      this.perspCam.far = far
      this.perspCam.updateProjectionMatrix()
    }
  }

  private scaleMarkers() {
    const s = this.pixelWorldSize(this.hoverMarker.position) * 5
    this.hoverMarker.scale.setScalar(s)
    for (const m of this.measurements) {
      m.obj.children.forEach((c) => {
        if ((c as THREE.Mesh).isMesh) c.scale.setScalar(this.pixelWorldSize(c.position) * 4)
      })
    }
  }

  private pixelWorldSize(p: THREE.Vector3) {
    const h = this.container.clientHeight || 1
    if (this.camera === this.orthoCam) return (this.orthoCam.top - this.orthoCam.bottom) / this.orthoCam.zoom / h
    const d = this.camera.position.distanceTo(p)
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov / 2))) / h
  }

  // ------------------------------------------------------------------ models

  setModels(models: LoadedModel[], replace: boolean) {
    if (replace) this.clearModels(false)
    for (const m of models) {
      this.models.push(m)
      this.content.add(m.object)
    }
    if (replace && models[0]) this.setUpAxis(models[0].up, false)
    this.refreshMeshes()
    this.explodeReady = false
    if (this.explode) this.applyExplode()
    this.applyDisplayMode()
    this.applySection()
    this.fit()
    this.buildBvhInBackground()
    this.emit('tree')
    this.emit('stats')
  }

  clearModels(emit = true) {
    this.select(null)
    this.clearMeasurements()
    for (const m of this.models) {
      this.content.remove(m.object)
      m.object.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (mesh.geometry) {
          mesh.geometry.disposeBoundsTree?.()
          mesh.geometry.dispose()
        }
      })
    }
    this.models = []
    this.meshes = []
    if (emit) {
      this.emit('tree')
      this.emit('stats')
    }
    this.requestRender()
  }

  hasModels() {
    return this.models.length > 0
  }

  private refreshMeshes() {
    this.meshes = []
    this.content.traverse((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) this.meshes.push(o as THREE.Mesh)
    })
  }

  private triangleCount() {
    let n = 0
    for (const m of this.meshes) {
      const g = m.geometry
      if ((m as THREE.Mesh).isMesh) n += (g.index ? g.index.count : g.getAttribute('position').count) / 3
    }
    return n
  }

  /** Builds BVHs in small time slices after load so the UI stays responsive. */
  private buildBvhInBackground() {
    const queue = this.meshes.filter((m) => m.isMesh && !m.geometry.boundsTree)
    const step = () => {
      const t0 = performance.now()
      while (queue.length && performance.now() - t0 < 12) {
        const m = queue.shift()!
        if (!m.geometry.boundsTree && m.geometry.getAttribute('position')) m.geometry.computeBoundsTree()
      }
      if (queue.length) setTimeout(step, 0)
    }
    setTimeout(step, 50)
  }

  getStats(): ModelStats {
    const b = this.visibleBox()
    const size = b.isEmpty() ? new THREE.Vector3() : b.getSize(new THREE.Vector3())
    // report size in model axes (undo the up-axis rotation)
    const s: [number, number, number] = this.upAxis === 'Z' ? [size.x, size.z, size.y] : [size.x, size.y, size.z]
    return {
      files: this.models.map((m) => ({ name: m.name, format: m.format, parseMs: m.parseMs })),
      meshes: this.meshes.length,
      triangles: Math.round(this.triangleCount()),
      size: s,
      units: this.models.every((m) => m.units === 'mm') ? 'mm' : this.models[0]?.units ?? '',
    }
  }

  getTree(): TreeNode[] {
    const walk = (o: THREE.Object3D): TreeNode => ({
      id: o.id,
      name: o.name || o.type,
      isMesh: !!(o as THREE.Mesh).isMesh || !!(o as THREE.Points).isPoints,
      visible: o.visible,
      children: o.children.filter((c) => !c.userData.__helper).map(walk),
    })
    return this.models.map((m) => walk(m.object))
  }

  // ------------------------------------------------------------------ camera

  private visibleBox(objs?: THREE.Object3D[]) {
    const box = new THREE.Box3()
    this.content.updateMatrixWorld(true)
    const list = objs ?? [this.content]
    for (const root of list) {
      root.traverseVisible((o) => {
        const m = o as THREE.Mesh
        if (!m.geometry || (!m.isMesh && !(o as THREE.Points).isPoints)) return
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
        _box.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld)
        box.union(_box)
      })
    }
    return box
  }

  fit(objs?: THREE.Object3D[], keepDirection = true) {
    const box = this.visibleBox(objs)
    if (box.isEmpty()) return
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    if (!objs) {
      this.radius = sphere.radius || 1
      this.center.copy(sphere.center)
      this.sectionBox.copy(box)
      this.updateGrid(box)
    }
    const dir = keepDirection
      ? this.camera.position.clone().sub(this.controls.target).normalize()
      : new THREE.Vector3(1, 0.7, 1.2).normalize()
    if (dir.lengthSq() < 0.5) dir.set(1, 0.7, 1.2).normalize()
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.perspCam.fov / 2)) * 1.05
    this.animateCamera(sphere.center, sphere.center.clone().addScaledVector(dir, dist))
  }

  private animId = 0
  private animateCamera(target: THREE.Vector3, pos: THREE.Vector3, up?: THREE.Vector3) {
    const id = ++this.animId
    const t0 = target.clone()
    const fromT = this.controls.target.clone()
    const fromP = this.camera.position.clone()
    const fromUp = this.camera.up.clone()
    const start = performance.now()
    const dur = 350
    const step = () => {
      if (id !== this.animId) return
      const k = Math.min(1, (performance.now() - start) / dur)
      const e = 1 - Math.pow(1 - k, 3)
      this.controls.target.lerpVectors(fromT, t0, e)
      this.perspCam.position.lerpVectors(fromP, pos, e)
      if (up) this.perspCam.up.lerpVectors(fromUp, up, e).normalize()
      this.perspCam.lookAt(this.controls.target)
      this.requestRender()
      if (k < 1) requestAnimationFrame(step)
    }
    step()
  }

  setView(v: ViewName) {
    const dirs: Record<ViewName, [number, number, number]> = {
      front: [0, 0, 1],
      back: [0, 0, -1],
      left: [-1, 0, 0],
      right: [1, 0, 0],
      top: [0, 1, 0],
      bottom: [0, -1, 0],
      iso: [1, 0.8, 1],
    }
    const d = new THREE.Vector3(...dirs[v]).normalize()
    const box = this.visibleBox()
    if (box.isEmpty()) return
    const s = box.getBoundingSphere(new THREE.Sphere())
    const dist = (s.radius / Math.sin(THREE.MathUtils.degToRad(this.perspCam.fov / 2))) * 1.05
    const up = v === 'top' ? new THREE.Vector3(0, 0, -1) : v === 'bottom' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0)
    this.animateCamera(s.center, s.center.clone().addScaledVector(d, dist), up)
  }

  setProjection(p: 'perspective' | 'orthographic') {
    const next = p === 'orthographic' ? this.orthoCam : this.perspCam
    if (next === this.camera) return
    this.camera = next
    this.requestRender()
  }

  /** OrbitControls always drive the perspective camera; the orthographic one mirrors it every frame
   *  (its frustum size follows the orbit distance, so wheel-zoom works the same in both modes). */
  private syncOrtho() {
    if (this.camera !== this.orthoCam) return
    const dir = this.perspCam.position.clone().sub(this.controls.target).normalize()
    this.orthoCam.position.copy(this.controls.target).addScaledVector(dir, this.radius * 4)
    this.orthoCam.up.copy(this.perspCam.up)
    this.orthoCam.zoom = 1
    this.updateOrthoFrustum()
    this.orthoCam.near = -this.radius * 20
    this.orthoCam.far = this.radius * 20
    this.orthoCam.lookAt(this.controls.target)
    this.orthoCam.updateProjectionMatrix()
  }

  setUpAxis(up: 'Y' | 'Z', refit = true) {
    this.upAxis = up
    this.content.rotation.set(up === 'Z' ? -Math.PI / 2 : 0, 0, 0)
    this.content.updateMatrixWorld(true)
    this.explodeReady = false
    if (this.explode) this.applyExplode()
    if (refit) this.fit(undefined, false)
    this.applySection()
    this.requestRender()
  }

  private updateGrid(box: THREE.Box3) {
    if (this.grid) {
      this.helpers.remove(this.grid)
      this.grid.geometry.dispose()
    }
    const size = box.getSize(new THREE.Vector3())
    const span = Math.max(size.x, size.z) * 2.2
    const step = Math.pow(10, Math.floor(Math.log10(span / 10)))
    const divisions = Math.min(200, Math.round(span / step))
    this.grid = new THREE.GridHelper(divisions * step, divisions, 0x5a6475, 0x3a4150)
    ;(this.grid.material as THREE.Material).transparent = true
    ;(this.grid.material as THREE.Material).opacity = 0.35
    const c = box.getCenter(new THREE.Vector3())
    this.grid.position.set(c.x, box.min.y - size.y * 0.002, c.z)
    this.grid.visible = this.showGrid
    this.helpers.add(this.grid)
  }

  setGrid(v: boolean) {
    this.showGrid = v
    if (this.grid) this.grid.visible = v
    this.requestRender()
  }

  // ------------------------------------------------------------------ materials / display modes

  private forEachMaterial(fn: (m: THREE.Material) => void) {
    const seen = new Set<THREE.Material>()
    const visit = (m: THREE.Material | THREE.Material[] | undefined) => {
      if (!m) return
      for (const x of Array.isArray(m) ? m : [m]) if (!seen.has(x)) (seen.add(x), fn(x))
    }
    for (const mesh of this.meshes) {
      visit(mesh.material)
      visit(mesh.userData.__origMat)
    }
    visit(this.highlightMat)
  }

  setDisplayMode(mode: DisplayMode) {
    this.displayMode = mode
    this.applyDisplayMode()
  }

  private applyDisplayMode() {
    const mode = this.displayMode
    this.forEachMaterial((m) => {
      const mm = m as THREE.MeshStandardMaterial
      if (!mm.userData.__orig) {
        mm.userData.__orig = { transparent: mm.transparent, opacity: mm.opacity, depthWrite: mm.depthWrite }
      }
      const o = mm.userData.__orig
      if ('wireframe' in mm) mm.wireframe = mode === 'wireframe'
      if (mode === 'xray') {
        mm.transparent = true
        mm.opacity = Math.min(o.opacity, 0.18)
        mm.depthWrite = false
      } else {
        mm.transparent = o.transparent
        mm.opacity = o.opacity
        mm.depthWrite = o.depthWrite
      }
      mm.needsUpdate = true
    })
    this.setEdgesVisible(mode === 'edges' || mode === 'xray')
    this.requestRender()
  }

  /** Feature edges are computed lazily (only when first needed), in time slices. */
  private setEdgesVisible(v: boolean) {
    const job = ++this.edgesJob
    if (!v) {
      for (const m of this.meshes) if (m.userData.__edges) m.userData.__edges.visible = false
      return
    }
    const queue = this.meshes.filter((m) => m.isMesh)
    const step = () => {
      if (job !== this.edgesJob) return
      const t0 = performance.now()
      while (queue.length && performance.now() - t0 < 14) {
        const m = queue.shift()!
        let e = m.userData.__edges as THREE.LineSegments | undefined
        if (!e) {
          e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25), this.edgeMat)
          e.userData.__helper = true
          e.raycast = () => {}
          m.userData.__edges = e
          m.add(e)
        }
        e.visible = true
      }
      this.requestRender()
      if (queue.length) setTimeout(step, 0)
    }
    step()
  }

  // ------------------------------------------------------------------ section planes

  setSection(axis: Axis, s: Partial<SectionState>) {
    Object.assign(this.section[axis], s)
    this.applySection()
  }

  private sectionHelpers: THREE.Object3D[] = []

  private applySection() {
    const box = this.sectionBox
    this.activePlanes = []
    this.sectionHelpers.forEach((h) => this.helpers.remove(h))
    this.sectionHelpers = []
    if (!box.isEmpty()) {
      const size = box.getSize(new THREE.Vector3())
      for (const axis of ['x', 'y', 'z'] as Axis[]) {
        const s = this.section[axis]
        if (!s.enabled) continue
        // Section axes are the model's own axes; map them to world axes (Z-up models are rotated).
        const [i, sign] = this.upAxis === 'Z' ? ({ x: [0, 1], y: [2, -1], z: [1, 1] } as const)[axis] : ({ x: [0, 1], y: [1, 1], z: [2, 1] } as const)[axis]
        const t = sign > 0 ? s.t : 1 - s.t
        const flip = sign > 0 ? s.flip : !s.flip
        const n = new THREE.Vector3().setComponent(i, flip ? 1 : -1)
        const pos = box.min.getComponent(i) + size.getComponent(i) * t
        const plane = this.planes[axis]
        plane.normal.copy(n)
        plane.constant = flip ? -pos : pos
        this.activePlanes.push(plane)
        // translucent plane quad showing where the cut is
        const w = Math.max(size.x, size.y, size.z) * 1.2
        const quad = new THREE.Mesh(
          new THREE.PlaneGeometry(w, w),
          new THREE.MeshBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }),
        )
        quad.lookAt(n)
        const c = box.getCenter(new THREE.Vector3()).setComponent(i, pos)
        quad.position.copy(c)
        quad.raycast = () => {}
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(quad.geometry),
          new THREE.LineBasicMaterial({ color: 0x3aa0ff, transparent: true, opacity: 0.6 }),
        )
        quad.add(edge)
        this.sectionHelpers.push(quad)
        this.helpers.add(quad)
      }
    }
    const planes = this.activePlanes.length ? this.activePlanes : null
    this.forEachMaterial((m) => {
      const had = !!m.clippingPlanes?.length
      m.clippingPlanes = planes
      this.setCapShading(m, !!planes)
      if (had !== !!planes) m.needsUpdate = true
    })
    this.edgeMat.clippingPlanes = planes
    this.edgeMat.needsUpdate = true
    this.requestRender()
  }

  /** Inside faces revealed by a section cut are tinted, so cut walls read like a CAD section view. */
  private setCapShading(m: THREE.Material, on: boolean) {
    if (!(m as THREE.MeshStandardMaterial).isMeshStandardMaterial && !(m as THREE.MeshPhongMaterial).isMeshPhongMaterial && !(m as THREE.MeshLambertMaterial).isMeshLambertMaterial) return
    if (!!m.userData.__cap === on) return
    m.userData.__cap = on
    if (on) {
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <dithering_fragment>',
          '#include <dithering_fragment>\nif (!gl_FrontFacing) gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.95, 0.35, 0.15), 0.65);',
        )
      }
      m.customProgramCacheKey = () => 'section-cap'
    } else {
      m.onBeforeCompile = () => {}
      m.customProgramCacheKey = () => ''
    }
    m.needsUpdate = true
  }

  private isClipped(p: THREE.Vector3) {
    return this.activePlanes.some((pl) => pl.distanceToPoint(p) < 0)
  }

  // ------------------------------------------------------------------ explode

  setExplode(f: number) {
    this.explode = f
    this.applyExplode()
  }

  private applyExplode() {
    if (!this.explodeReady) {
      // Reset, then record each part's outward direction (in its parent's local space).
      for (const m of this.meshes) if (m.userData.__origPos) m.position.copy(m.userData.__origPos)
      this.content.updateMatrixWorld(true)
      const box = this.visibleBox()
      const center = box.getCenter(new THREE.Vector3())
      for (const m of this.meshes) {
        if (!m.userData.__origPos) m.userData.__origPos = m.position.clone()
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox()
        const wc = m.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(m.matrixWorld)
        const delta = wc.clone().sub(center)
        const parent = m.parent!
        const p0 = parent.worldToLocal(wc.clone())
        const p1 = parent.worldToLocal(wc.clone().add(delta))
        m.userData.__explodeDir = p1.sub(p0)
      }
      this.explodeReady = true
    }
    for (const m of this.meshes) {
      m.position.copy(m.userData.__origPos).addScaledVector(m.userData.__explodeDir, this.explode * 1.5)
    }
    this.requestRender()
  }

  // ------------------------------------------------------------------ visibility / selection

  private byId(id: number) {
    return this.content.getObjectById(id) ?? null
  }

  setVisible(id: number, v: boolean) {
    const o = this.byId(id)
    if (!o) return
    o.visible = v
    if (v) for (let p = o.parent; p && p !== this.content; p = p.parent) p.visible = true
    if (!v && this.selected && isDescendant(this.selected, o)) this.select(null)
    this.emit('tree')
    this.requestRender()
  }

  hideSelected() {
    if (this.selected) this.setVisible(this.selected.id, false)
  }

  isolate(id?: number) {
    const target = id !== undefined ? this.byId(id) : this.selected
    if (!target) return
    this.content.traverse((o) => {
      if (o === this.content || o.userData.__helper) return
      o.visible = isDescendant(o, target) || isDescendant(target, o)
    })
    this.fit([target])
    this.emit('tree')
    this.requestRender()
  }

  showAll() {
    this.content.traverse((o) => {
      if (!o.userData.__helper || this.displayMode === 'edges' || this.displayMode === 'xray') o.visible = true
    })
    this.emit('tree')
    this.requestRender()
  }

  focus(id?: number) {
    const o = id !== undefined ? this.byId(id) : this.selected
    if (o) this.fit([o])
  }

  selectById(id: number | null) {
    if (id === null) return this.select(null)
    const o = this.byId(id)
    if (!o) return
    if ((o as THREE.Mesh).isMesh) this.select(o as THREE.Mesh)
    else {
      // group selected in the tree: select its first mesh but frame the whole group
      let first: THREE.Mesh | null = null
      o.traverse((c) => {
        if (!first && (c as THREE.Mesh).isMesh) first = c as THREE.Mesh
      })
      this.select(first)
    }
  }

  select(mesh: THREE.Mesh | null) {
    if (this.selected === mesh) return
    if (this.selected) {
      this.selected.material = this.selected.userData.__origMat
      delete this.selected.userData.__origMat
    }
    this.selected = mesh
    if (mesh && mesh.isMesh) {
      mesh.userData.__origMat = mesh.material
      mesh.material = this.highlightMat
    }
    this.emit('selection')
    this.requestRender()
  }

  getSelectionInfo(): SelectionInfo | null {
    const m = this.selected
    if (!m) return null
    const g = m.geometry
    const box = this.visibleBox([m])
    const size = box.getSize(new THREE.Vector3())
    const path: string[] = []
    for (let p = m.parent; p && p !== this.content; p = p.parent) path.unshift(p.name || p.type)
    const orig = m.userData.__origMat as THREE.MeshStandardMaterial | THREE.MeshStandardMaterial[]
    const first = Array.isArray(orig) ? orig[0] : orig
    return {
      id: m.id,
      name: m.name || 'Unnamed part',
      path: path.join(' / '),
      triangles: Math.round((g.index ? g.index.count : g.getAttribute('position').count) / 3),
      vertices: g.getAttribute('position').count,
      size: this.upAxis === 'Z' ? [size.x, size.z, size.y] : [size.x, size.y, size.z],
      color: first?.color ? '#' + first.color.getHexString(THREE.SRGBColorSpace) : null,
    }
  }

  // ------------------------------------------------------------------ picking

  private ndc(ev: PointerEvent | MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1)
  }

  private pick(ev: PointerEvent | MouseEvent) {
    this.raycaster.setFromCamera(this.ndc(ev), this.camera)
    ;(this.raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = this.activePlanes.length === 0
    const visible = this.meshes.filter((m) => m.isMesh && isVisible(m))
    const hits = this.raycaster.intersectObjects(visible, false)
    return hits.find((h) => !this.isClipped(h.point)) ?? null
  }

  /** Snap to the nearest triangle corner when it is within a few pixels of the cursor. */
  private snap(hit: THREE.Intersection, ev: PointerEvent | MouseEvent): THREE.Vector3 {
    if (!hit.face) return hit.point.clone()
    const mesh = hit.object as THREE.Mesh
    const pos = mesh.geometry.getAttribute('position')
    const rect = this.renderer.domElement.getBoundingClientRect()
    let best = hit.point.clone()
    let bestD = 10 // px
    for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
      const w = _v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).clone()
      const s = w.clone().project(this.camera)
      const px = ((s.x + 1) / 2) * rect.width + rect.left
      const py = ((1 - s.y) / 2) * rect.height + rect.top
      const d = Math.hypot(px - ev.clientX, py - ev.clientY)
      if (d < bestD) {
        bestD = d
        best = w
      }
    }
    return best
  }

  private onPointerDown = (ev: PointerEvent) => {
    this.downPos = { x: ev.clientX, y: ev.clientY }
    this.animId++ // cancel camera animation
  }

  private onPointerUp = (ev: PointerEvent) => {
    if (!this.downPos || ev.button !== 0) return
    const moved = Math.hypot(ev.clientX - this.downPos.x, ev.clientY - this.downPos.y)
    this.downPos = null
    if (moved > 4) return
    const hit = this.pick(ev)
    if (this.tool === 'measure') {
      if (!hit) return
      const p = this.snap(hit, ev)
      if (!this.measureStart) this.measureStart = p
      else {
        this.addMeasurement(this.measureStart, p)
        this.measureStart = null
      }
      this.emit('measure')
      return
    }
    this.select(hit ? (hit.object as THREE.Mesh) : null)
  }

  private hoverPending = false
  private onPointerMove = (ev: PointerEvent) => {
    if (this.tool !== 'measure' || this.hoverPending || ev.buttons) return
    this.hoverPending = true
    requestAnimationFrame(() => {
      this.hoverPending = false
      const hit = this.pick(ev)
      this.hoverMarker.visible = !!hit
      if (hit) this.hoverMarker.position.copy(this.snap(hit, ev))
      this.requestRender()
    })
  }

  /** Double-click sets the orbit centre to the clicked point (standard CAD behaviour). */
  private onDoubleClick = (ev: MouseEvent) => {
    const hit = this.pick(ev)
    if (!hit) return
    const offset = this.perspCam.position.clone().sub(this.controls.target)
    const dist = Math.max(offset.length() * 0.6, this.radius * 0.02)
    this.animateCamera(hit.point, hit.point.clone().add(offset.normalize().multiplyScalar(dist)))
  }

  // ------------------------------------------------------------------ measure

  setTool(t: Tool) {
    this.tool = t
    this.measureStart = null
    this.hoverMarker.visible = false
    this.renderer.domElement.style.cursor = t === 'measure' ? 'crosshair' : ''
    this.requestRender()
  }

  private addMeasurement(a: THREE.Vector3, b: THREE.Vector3) {
    const g = new THREE.Group()
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([a, b]),
      new THREE.LineBasicMaterial({ color: 0xffd400, depthTest: false }),
    )
    line.renderOrder = 998
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false })
    const geo = new THREE.SphereGeometry(1, 12, 8)
    for (const p of [a, b]) {
      const d = new THREE.Mesh(geo, dotMat)
      d.position.copy(p)
      d.renderOrder = 999
      g.add(d)
    }
    const div = document.createElement('div')
    div.className = 'measure-label'
    div.textContent = this.formatLength(a.distanceTo(b))
    const label = new CSS2DObject(div)
    label.position.lerpVectors(a, b, 0.5)
    g.add(line, label)
    this.measureGroup.add(g)
    this.measurements.push({ id: ++this.measureId, a: a.clone(), b: b.clone(), obj: g })
    this.requestRender()
  }

  /** Distance components expressed in the model's own axes. */
  measurementDelta(a: THREE.Vector3, b: THREE.Vector3): [number, number, number] {
    const d = b.clone().sub(a)
    return this.upAxis === 'Z' ? [Math.abs(d.x), Math.abs(d.z), Math.abs(d.y)] : [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)]
  }

  formatLength(v: number) {
    const u = this.getStats().units
    return `${v.toFixed(v < 10 ? 3 : v < 1000 ? 2 : 1)} ${u === 'mm' ? 'mm' : ''}`.trim()
  }

  isMeasuring() {
    return !!this.measureStart
  }

  removeMeasurement(id: number) {
    const i = this.measurements.findIndex((m) => m.id === id)
    if (i < 0) return
    this.disposeMeasure(this.measurements[i].obj)
    this.measurements.splice(i, 1)
    this.emit('measure')
    this.requestRender()
  }

  clearMeasurements() {
    this.measurements.forEach((m) => this.disposeMeasure(m.obj))
    this.measurements = []
    this.measureStart = null
    this.emit('measure')
    this.requestRender()
  }

  private disposeMeasure(g: THREE.Object3D) {
    this.measureGroup.remove(g)
    g.traverse((o) => {
      if (o instanceof CSS2DObject) o.element.remove()
    })
  }

  // ------------------------------------------------------------------ fly-through (walk inside)

  setFlyMode(on: boolean) {
    this.flyMode = on
    this.keys.clear()
    this.controls.enableZoom = !on
    if (on) {
      // Put the orbit pivot just in front of the eye: dragging now "looks around" instead of orbiting.
      const dir = this.controls.target.clone().sub(this.perspCam.position).normalize()
      this.controls.target.copy(this.perspCam.position).addScaledVector(dir, this.radius * 0.01)
    }
    this.controls.update()
    this.requestRender()
  }

  private flyStep(dt: number) {
    const speed = this.radius * 0.35 * (this.keys.has('shift') ? 4 : 1) * dt
    const fwd = this.controls.target.clone().sub(this.perspCam.position).normalize()
    const right = fwd.clone().cross(this.perspCam.up).normalize()
    const move = new THREE.Vector3()
    if (this.keys.has('w') || this.keys.has('arrowup')) move.add(fwd)
    if (this.keys.has('s') || this.keys.has('arrowdown')) move.sub(fwd)
    if (this.keys.has('d') || this.keys.has('arrowright')) move.add(right)
    if (this.keys.has('a') || this.keys.has('arrowleft')) move.sub(right)
    if (this.keys.has('e')) move.add(this.perspCam.up)
    if (this.keys.has('q')) move.sub(this.perspCam.up)
    if (move.lengthSq() === 0) return
    move.normalize().multiplyScalar(speed)
    this.perspCam.position.add(move)
    this.controls.target.add(move)
    this.requestRender()
  }

  private onWheel = (ev: WheelEvent) => {
    if (!this.flyMode) return
    ev.preventDefault()
    const fwd = this.controls.target.clone().sub(this.perspCam.position).normalize()
    const step = -Math.sign(ev.deltaY) * this.radius * 0.04
    this.perspCam.position.addScaledVector(fwd, step)
    this.controls.target.addScaledVector(fwd, step)
    this.requestRender()
  }

  private onKeyDown = (ev: KeyboardEvent) => {
    if (!this.flyMode || isTyping(ev)) return
    const k = ev.key.toLowerCase()
    if (['w', 'a', 's', 'd', 'q', 'e', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      this.keys.add(k)
      ev.preventDefault()
    }
  }
  private onKeyUp = (ev: KeyboardEvent) => {
    this.keys.delete(ev.key.toLowerCase())
  }

  // ------------------------------------------------------------------ export

  /** Returns a PNG of the current view, optionally with the 2D sketch overlay composited on top. */
  screenshot(overlay?: HTMLCanvasElement | null, background = '#1d2230'): string {
    this.render()
    const src = this.renderer.domElement
    const c = document.createElement('canvas')
    c.width = src.width
    c.height = src.height
    const ctx = c.getContext('2d')!
    ctx.fillStyle = background
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.drawImage(src, 0, 0)
    if (overlay) ctx.drawImage(overlay, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.resizeObs.disconnect()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.clearModels(false)
    this.controls.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
    this.labelRenderer.domElement.remove()
  }
}

function isDescendant(o: THREE.Object3D, ancestor: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === ancestor) return true
  return false
}

function isVisible(o: THREE.Object3D) {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false
  return true
}

function isTyping(ev: KeyboardEvent) {
  const t = ev.target as HTMLElement
  if (!t) return false
  if (t.tagName === 'TEXTAREA' || t.isContentEditable) return true
  return t.tagName === 'INPUT' && !['checkbox', 'range', 'radio', 'button'].includes((t as HTMLInputElement).type)
}
