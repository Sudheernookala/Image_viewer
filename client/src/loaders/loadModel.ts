import * as THREE from 'three'
import { FORMATS, extOf } from './formats'

export type Quality = 'draft' | 'normal' | 'fine'

export interface LoadedModel {
  object: THREE.Object3D
  name: string
  format: string
  up: 'Y' | 'Z'
  units: string
  parseMs: number
}

export type ProgressFn = (msg: string) => void

// ---------------- materials ----------------

const DEFAULT_COLOR = new THREE.Color('#8e99ab') // neutral steel-grey for formats without colours (STL, OBJ without MTL)
const materialCache = new Map<string, THREE.MeshStandardMaterial>()

/** One shared material per colour keeps draw-state changes and GPU memory low for big assemblies. */
export function cadMaterial(rgb: number[] | null, transparent = false): THREE.MeshStandardMaterial {
  const key = (rgb ? rgb.map((v) => v.toFixed(3)).join(',') : 'default') + (transparent ? 't' : '')
  let m = materialCache.get(key)
  if (!m) {
    const color = rgb ? new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace) : DEFAULT_COLOR.clone()
    m = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.15,
      roughness: 0.45,
      side: THREE.DoubleSide,
      transparent,
      opacity: transparent ? 0.35 : 1,
      depthWrite: !transparent,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })
    materialCache.set(key, m)
  }
  return m
}

const GLASS_RE = /glass|window|windscreen|windshield|lens/i

// ---------------- workers ----------------

let occtWorker: Worker | null = null
let meshWorker: Worker | null = null
let reqId = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

function onWorkerMessage(ev: MessageEvent) {
  const p = pending.get(ev.data.id)
  if (!p) return
  pending.delete(ev.data.id)
  if (ev.data.ok) p.resolve(ev.data)
  else p.reject(new Error(ev.data.error))
}

function getOcctWorker(): Worker {
  if (!occtWorker) {
    occtWorker = new Worker(import.meta.env.BASE_URL + 'occt/occt-worker.js')
    occtWorker.onmessage = onWorkerMessage
  }
  return occtWorker
}

function getMeshWorker(): Worker {
  if (!meshWorker) {
    meshWorker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' })
    meshWorker.onmessage = onWorkerMessage
  }
  return meshWorker
}

function callWorker<T>(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = ++reqId
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ ...msg, id }, transfer)
  })
}

/** Starts downloading/compiling the ~10 MB OpenCascade WASM in the background so the first STEP opens fast. */
export function warmUpCadKernel() {
  callWorker(getOcctWorker(), { type: 'warmup' }).catch(() => {})
}

/** Kills in-flight parsing (e.g. user cancelled a huge file). Workers are re-created lazily. */
export function cancelLoading() {
  for (const [, p] of pending) p.reject(new Error('Cancelled'))
  pending.clear()
  occtWorker?.terminate()
  meshWorker?.terminate()
  occtWorker = meshWorker = null
}

// ---------------- CAD (OpenCascade) ----------------

interface OcctNode {
  name: string
  meshes: number[]
  children: OcctNode[]
}
interface OcctMesh {
  name: string
  color: number[] | null
  position: Float32Array
  normal: Float32Array | null
  index: Uint32Array
  faces: [number, number, number[] | null][]
}

const QUALITY: Record<Quality, { linearDeflection: number; angularDeflection: number }> = {
  draft: { linearDeflection: 0.004, angularDeflection: 0.8 },
  normal: { linearDeflection: 0.001, angularDeflection: 0.5 },
  fine: { linearDeflection: 0.0003, angularDeflection: 0.2 },
}

async function loadCad(file: File, ext: string, quality: Quality): Promise<THREE.Object3D> {
  const format = ext === 'stp' ? 'step' : ext === 'igs' ? 'iges' : ext === 'brp' ? 'brep' : ext
  const buffer = await file.arrayBuffer()
  const res = await callWorker<{ root: OcctNode; meshes: OcctMesh[] }>(
    getOcctWorker(),
    {
      format,
      buffer,
      params: { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', ...QUALITY[quality] },
    },
    [buffer],
  )

  const build = (node: OcctNode, depth: number): THREE.Object3D => {
    const group = new THREE.Group()
    group.name = node.name || (depth === 0 ? file.name : 'Assembly')
    // Unnamed meshes (e.g. solids of a multi-solid part) take the name of the node that owns them.
    node.meshes.forEach((mi, k) => {
      const m = res.meshes[mi]
      if (!m.name && node.name) m.name = node.meshes.length > 1 ? `${node.name} (${k + 1})` : node.name
      group.add(buildMesh(m, mi))
    })
    for (const c of node.children) group.add(build(c, depth + 1))
    // Collapse single-child wrapper groups to keep the tree readable.
    if (group.children.length === 1 && node.meshes.length === 0 && depth > 0) {
      const only = group.children[0]
      if (!only.name || only.name.startsWith('Assembly')) only.name = group.name
      return only
    }
    return group
  }

  const root = build(res.root, 0)
  root.name = file.name
  return root
}

function buildMesh(m: OcctMesh, i: number): THREE.Mesh {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3))
  if (m.normal && m.normal.length === m.position.length) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3))
  else g.computeVertexNormals()
  g.setIndex(new THREE.BufferAttribute(m.index, 1))

  const name = m.name || `Part ${i + 1}`
  const glass = GLASS_RE.test(name)
  let material: THREE.Material | THREE.Material[] = cadMaterial(m.color, glass)

  // Per-face colours (common in STEP): split into draw groups with their own material.
  const faceColors = m.faces.some((f) => f[2])
  if (faceColors) {
    const mats: THREE.Material[] = []
    const idx = new Map<string, number>()
    for (const [first, last, c] of m.faces) {
      const color = c ?? m.color
      const key = color ? color.join(',') : 'none'
      let mi = idx.get(key)
      if (mi === undefined) {
        mi = mats.length
        idx.set(key, mi)
        mats.push(cadMaterial(color, glass))
      }
      g.addGroup(first * 3, (last - first + 1) * 3, mi)
    }
    material = mats.length === 1 ? mats[0] : mats
    if (mats.length === 1) g.clearGroups()
  }

  const mesh = new THREE.Mesh(g, material)
  mesh.name = name
  return mesh
}

// ---------------- Mesh formats ----------------

function makeManager(resources: Map<string, File>): { manager: THREE.LoadingManager; dispose: () => void } {
  const urls: string[] = []
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return url
    const base = decodeURIComponent(url.split(/[\\/]/).pop() ?? url).toLowerCase()
    const f = resources.get(base)
    if (!f) return url
    const u = URL.createObjectURL(f)
    urls.push(u)
    return u
  })
  return { manager, dispose: () => setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 30000) }
}

function geometryToObject(g: THREE.BufferGeometry, name: string): THREE.Object3D {
  if (!g.index && !g.getAttribute('normal') && g.getAttribute('position').count > 0 && isPointCloud(name)) {
    return pointsOf(g, name)
  }
  if (!g.getAttribute('normal')) g.computeVertexNormals()
  const hasColor = !!g.getAttribute('color')
  const mat = hasColor
    ? new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.1 })
    : cadMaterial(null)
  const mesh = new THREE.Mesh(g, mat)
  mesh.name = name
  return mesh
}

function isPointCloud(name: string) {
  return ['pcd', 'xyz'].includes(extOf(name))
}

function pointsOf(g: THREE.BufferGeometry, name: string) {
  g.computeBoundingSphere()
  const size = (g.boundingSphere?.radius ?? 1) / 400
  const p = new THREE.Points(
    g,
    new THREE.PointsMaterial({ size, vertexColors: !!g.getAttribute('color'), color: g.getAttribute('color') ? 0xffffff : 0x8fb3ff }),
  )
  p.name = name
  return p
}

function parseOFF(text: string): THREE.BufferGeometry {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
  let li = 0
  if (/^C?N?OFF/.test(lines[0])) li++
  const [nv, nf] = lines[li++].split(/\s+/).map(Number)
  const pos = new Float32Array(nv * 3)
  for (let i = 0; i < nv; i++) {
    const p = lines[li++].split(/\s+/).map(Number)
    pos.set([p[0], p[1], p[2]], i * 3)
  }
  const idx: number[] = []
  for (let i = 0; i < nf; i++) {
    const p = lines[li++].split(/\s+/).map(Number)
    const n = p[0]
    for (let k = 2; k < n; k++) idx.push(p[1], p[k], p[k + 1])
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

async function loadMesh(file: File, ext: string, resources: Map<string, File>): Promise<THREE.Object3D> {
  const { manager, dispose } = makeManager(resources)
  try {
    switch (ext) {
      case 'stl':
      case 'ply': {
        const buffer = await file.arrayBuffer()
        const res = await callWorker<{ attrs: Record<string, { array: Float32Array; itemSize: number }>; index: Uint32Array | null }>(
          getMeshWorker(),
          { format: ext, buffer },
          [buffer],
        )
        const g = new THREE.BufferGeometry()
        for (const [k, v] of Object.entries(res.attrs)) g.setAttribute(k, new THREE.BufferAttribute(v.array, v.itemSize))
        if (res.index) g.setIndex(new THREE.BufferAttribute(res.index, 1))
        if (ext === 'ply' && !res.index && !res.attrs.normal) return pointsOf(g, file.name)
        return geometryToObject(g, file.name)
      }
      case 'obj': {
        const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js')
        const loader = new OBJLoader(manager)
        const text = await file.text()
        const mtlName = text.match(/^mtllib\s+(.+)$/m)?.[1]?.trim()
        const mtlFile = mtlName ? resources.get(mtlName.split(/[\\/]/).pop()!.toLowerCase()) : undefined
        if (mtlFile) {
          const { MTLLoader } = await import('three/examples/jsm/loaders/MTLLoader.js')
          const mats = new MTLLoader(manager).parse(await mtlFile.text(), '')
          mats.preload()
          loader.setMaterials(mats)
        }
        const obj = loader.parse(text)
        if (!mtlFile) obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = cadMaterial(null) })
        return obj
      }
      case 'gltf':
      case 'glb': {
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js')
        const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js')
        const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js')
        const loader = new GLTFLoader(manager)
        loader.setDRACOLoader(new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/'))
        loader.setMeshoptDecoder(MeshoptDecoder)
        const data = ext === 'glb' ? await file.arrayBuffer() : await file.text()
        const gltf = await loader.parseAsync(data, '')
        return gltf.scene
      }
      case 'fbx': {
        const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js')
        return new FBXLoader(manager).parse(await file.arrayBuffer(), '')
      }
      case '3mf': {
        const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js')
        return new ThreeMFLoader(manager).parse(await file.arrayBuffer())
      }
      case 'amf': {
        const { AMFLoader } = await import('three/examples/jsm/loaders/AMFLoader.js')
        return new AMFLoader(manager).parse(await file.arrayBuffer())
      }
      case 'dae': {
        const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js')
        const c = new ColladaLoader(manager).parse(await file.text(), '')
        if (!c) throw new Error('Invalid COLLADA file')
        return c.scene
      }
      case '3ds': {
        const { TDSLoader } = await import('three/examples/jsm/loaders/TDSLoader.js')
        return new TDSLoader(manager).parse(await file.arrayBuffer(), '')
      }
      case 'wrl':
      case 'vrml': {
        const { VRMLLoader } = await import('three/examples/jsm/loaders/VRMLLoader.js')
        return new VRMLLoader(manager).parse(await file.text(), '')
      }
      case 'vtk':
      case 'vtp': {
        const { VTKLoader } = await import('three/examples/jsm/loaders/VTKLoader.js')
        return geometryToObject(new VTKLoader(manager).parse(await file.arrayBuffer(), ''), file.name)
      }
      case 'pcd': {
        const { PCDLoader } = await import('three/examples/jsm/loaders/PCDLoader.js')
        const p = new PCDLoader(manager).parse(await file.arrayBuffer())
        return pointsOf(p.geometry, file.name)
      }
      case 'xyz': {
        const { XYZLoader } = await import('three/examples/jsm/loaders/XYZLoader.js')
        const url = URL.createObjectURL(file)
        try {
          const g = await new XYZLoader(manager).loadAsync(url)
          return pointsOf(g, file.name)
        } finally {
          URL.revokeObjectURL(url)
        }
      }
      case 'lwo': {
        const { LWOLoader } = await import('three/examples/jsm/loaders/LWOLoader.js')
        const lwo = new LWOLoader(manager).parse(await file.arrayBuffer(), '', file.name)
        const g = new THREE.Group()
        lwo.meshes.forEach((m) => g.add(m))
        return g
      }
      case 'usdz': {
        const { USDLoader } = await import('three/examples/jsm/loaders/USDLoader.js')
        return new USDLoader(manager).parse(await file.arrayBuffer())
      }
      case 'off':
        return geometryToObject(parseOFF(await file.text()), file.name)
      default:
        throw new Error(`Unsupported format: .${ext}`)
    }
  } finally {
    dispose()
  }
}

// ---------------- entry point ----------------

export async function loadModelFile(
  file: File,
  resources: Map<string, File>,
  quality: Quality,
  onProgress: ProgressFn,
): Promise<LoadedModel> {
  const ext = extOf(file.name)
  const info = FORMATS[ext]
  if (!info) throw new Error(`Unsupported file type: ${file.name}`)
  const t0 = performance.now()
  onProgress(
    info.kind === 'cad'
      ? `Tessellating ${info.label} with OpenCascade: ${file.name}`
      : `Parsing ${info.label}: ${file.name}`,
  )
  const object = info.kind === 'cad' ? await loadCad(file, ext, quality) : await loadMesh(file, ext, resources)
  object.name = object.name || file.name
  return {
    object,
    name: file.name,
    format: info.label,
    up: info.up,
    units: info.kind === 'cad' ? 'mm' : 'units',
    parseMs: performance.now() - t0,
  }
}
