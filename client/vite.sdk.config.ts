import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// Builds the embeddable SDK: dist/sdk/cad-viewer.js (ES module, React bundled in, CSS inlined).
// It is served by the viewer server; host pages load it with <script type="module" src=".../sdk/cad-viewer.js">.
export default defineConfig({
  plugins: [react()],
  publicDir: 'sdk-public', // cad-viewer-host.js is copied next to the SDK
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'dist/sdk',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    lib: {
      entry: resolve(__dirname, 'src/sdk/index.tsx'),
      formats: ['es'],
      fileName: () => 'cad-viewer.js',
    },
  },
})
