import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// Copies the OpenCascade WASM build (STEP / IGES / BREP reader) into public/occt
// so the classic web worker in public/occt/occt-worker.js can importScripts() it.
function copyOcct(): Plugin {
  return {
    name: 'copy-occt',
    buildStart() {
      const src = resolve(__dirname, 'node_modules/occt-import-js/dist')
      const dst = resolve(__dirname, 'public/occt')
      mkdirSync(dst, { recursive: true })
      for (const f of ['occt-import-js.js', 'occt-import-js.wasm']) copyFileSync(resolve(src, f), resolve(dst, f))
    },
  }
}

export default defineConfig({
  plugins: [react(), copyOcct()],
  server: {
    proxy: { '/api': 'http://localhost:3001' },
  },
  build: {
    chunkSizeWarningLimit: 1500,
  },
})
