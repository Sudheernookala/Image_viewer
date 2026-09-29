/* Classic web worker: parses STEP / IGES / BREP with OpenCascade (WASM) off the main thread.
   ENGINE_BASE is set when the worker is started from a blob (viewer embedded on another origin). */
var BASE = self.ENGINE_BASE || '';
importScripts(BASE + 'occt-import-js.js');

let occtPromise = null;
function getOcct() {
  if (!occtPromise) occtPromise = occtimportjs({ locateFile: (p) => BASE + p });
  return occtPromise;
}

onmessage = async (ev) => {
  const { id, type, format, buffer, params } = ev.data;
  if (type === 'warmup') {
    await getOcct();
    postMessage({ id, ok: true });
    return;
  }
  try {
    const occt = await getOcct();
    const res = occt.ReadFile(format, new Uint8Array(buffer), params || null);
    if (!res || !res.success) throw new Error('OpenCascade could not read this ' + format.toUpperCase() + ' file');
    const transfer = [];
    // Convert plain JS arrays into typed arrays and transfer them (zero-copy) to the main thread.
    const meshes = res.meshes.map((m) => {
      const position = new Float32Array(m.attributes.position.array);
      const normal = m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null;
      const index = new Uint32Array(m.index.array);
      transfer.push(position.buffer, index.buffer);
      if (normal) transfer.push(normal.buffer);
      const faces = (m.brep_faces || []).map((f) => [f.first, f.last, f.color || null]);
      return { name: m.name || '', color: m.color || null, position, normal, index, faces };
    });
    postMessage({ id, ok: true, root: res.root, meshes }, transfer);
  } catch (e) {
    postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
