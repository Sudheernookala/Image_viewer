export type FormatKind = 'cad' | 'mesh'

export interface FormatInfo {
  label: string
  kind: FormatKind
  /** Axis the format usually treats as "up". CAD tools are Z-up, most DCC/web formats are Y-up. */
  up: 'Y' | 'Z'
}

export const FORMATS: Record<string, FormatInfo> = {
  step: { label: 'STEP', kind: 'cad', up: 'Z' },
  stp: { label: 'STEP', kind: 'cad', up: 'Z' },
  iges: { label: 'IGES', kind: 'cad', up: 'Z' },
  igs: { label: 'IGES', kind: 'cad', up: 'Z' },
  brep: { label: 'BREP', kind: 'cad', up: 'Z' },
  brp: { label: 'BREP', kind: 'cad', up: 'Z' },
  stl: { label: 'STL', kind: 'mesh', up: 'Z' },
  '3mf': { label: '3MF', kind: 'mesh', up: 'Z' },
  amf: { label: 'AMF', kind: 'mesh', up: 'Z' },
  ply: { label: 'PLY', kind: 'mesh', up: 'Z' },
  obj: { label: 'OBJ', kind: 'mesh', up: 'Y' },
  gltf: { label: 'glTF', kind: 'mesh', up: 'Y' },
  glb: { label: 'GLB', kind: 'mesh', up: 'Y' },
  fbx: { label: 'FBX', kind: 'mesh', up: 'Y' },
  dae: { label: 'COLLADA', kind: 'mesh', up: 'Y' },
  '3ds': { label: '3DS', kind: 'mesh', up: 'Z' },
  wrl: { label: 'VRML', kind: 'mesh', up: 'Y' },
  vrml: { label: 'VRML', kind: 'mesh', up: 'Y' },
  vtk: { label: 'VTK', kind: 'mesh', up: 'Z' },
  vtp: { label: 'VTK', kind: 'mesh', up: 'Z' },
  pcd: { label: 'PCD (point cloud)', kind: 'mesh', up: 'Z' },
  xyz: { label: 'XYZ (point cloud)', kind: 'mesh', up: 'Z' },
  lwo: { label: 'LightWave', kind: 'mesh', up: 'Y' },
  usdz: { label: 'USDZ', kind: 'mesh', up: 'Y' },
  off: { label: 'OFF', kind: 'mesh', up: 'Z' },
}

/** Companion files (materials, buffers, textures) that are not models on their own. */
export const RESOURCE_EXTS = new Set(['mtl', 'bin', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'tga', 'webp', 'dds', 'ktx2', 'tif', 'tiff'])

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function isModelFile(name: string): boolean {
  return extOf(name) in FORMATS
}

export const ACCEPT = [...Object.keys(FORMATS), ...RESOURCE_EXTS].map((e) => '.' + e).join(',')

export const SUPPORTED_LIST = [...new Set(Object.values(FORMATS).map((f) => f.label))].join(', ')
