import { resolve } from 'path'
import { defineConfig } from 'vite'

// Sitio multi-página: splash (/) + conductores + negocio.
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main:        resolve(__dirname, 'index.html'),
        conductores: resolve(__dirname, 'conductores.html'),
        negocio:     resolve(__dirname, 'negocio.html'),
      },
    },
  },
})
