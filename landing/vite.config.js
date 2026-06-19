import { resolve } from 'path'
import { defineConfig } from 'vite'

// Sitio multi-página: splash (/) + conductores + negocio + legales.
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main:        resolve(__dirname, 'index.html'),
        conductores: resolve(__dirname, 'conductores.html'),
        negocio:     resolve(__dirname, 'negocio.html'),
        terminos:    resolve(__dirname, 'terminos.html'),
        privacidad:  resolve(__dirname, 'privacidad.html'),
      },
    },
  },
})
