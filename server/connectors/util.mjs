export const MODEL_EXTS = new Set(['step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', '3mf', 'amf', 'ply', 'obj', 'gltf', 'glb', 'fbx', 'dae', '3ds', 'wrl', 'vrml', 'vtk', 'vtp', 'pcd', 'xyz', 'lwo', 'usdz', 'off'])

export const ext = (n = '') => (n.includes('.') ? n.split('.').pop().toLowerCase() : '')

/** Reads "a.b.c" from an object. */
export function pick(obj, path) {
  if (!path) return undefined
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/** Replaces ${ENV_VAR} with environment values (keeps secrets out of config files). */
export function expandEnv(value) {
  if (typeof value === 'string') return value.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '')
  if (Array.isArray(value)) return value.map(expandEnv)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]))
  return value
}

/** Fills {placeholders} in a URL template; values are URL-encoded. */
export function fillUrl(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => (k === 'baseUrl' ? vars.baseUrl : encodeURIComponent(vars[k] ?? '')))
}
