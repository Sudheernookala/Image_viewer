/// <reference lib="webworker" />
// Parses large, simple mesh formats (STL, PLY) off the main thread and transfers typed arrays back.
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import type { BufferGeometry } from 'three'

interface Req {
  id: number
  format: 'stl' | 'ply'
  buffer: ArrayBuffer
}

self.onmessage = (ev: MessageEvent<Req>) => {
  const { id, format, buffer } = ev.data
  try {
    const geom: BufferGeometry = format === 'stl' ? new STLLoader().parse(buffer) : new PLYLoader().parse(buffer)
    const attrs: Record<string, { array: Float32Array; itemSize: number }> = {}
    const transfer: ArrayBuffer[] = []
    for (const name of ['position', 'normal', 'color']) {
      const a = geom.getAttribute(name)
      if (!a) continue
      const array = a.array instanceof Float32Array ? a.array : new Float32Array(a.array as ArrayLike<number>)
      attrs[name] = { array, itemSize: a.itemSize }
      transfer.push(array.buffer as ArrayBuffer)
    }
    let index: Uint32Array | null = null
    if (geom.index) {
      index = new Uint32Array(geom.index.array as ArrayLike<number>)
      transfer.push(index.buffer as ArrayBuffer)
    }
    ;(self as unknown as Worker).postMessage({ id, ok: true, attrs, index }, transfer)
  } catch (e) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: String((e as Error)?.message ?? e) })
  }
}
