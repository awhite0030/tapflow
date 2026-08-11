import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { compression } from 'vite-plugin-compression2'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    // Precompress text assets to .br at build time (brotli only) so the relay serves them with no runtime CPU.
    compression({ include: /\.(js|css|html|svg|json)$/, algorithms: ['brotliCompress'], deleteOriginalAssets: false }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined

          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react'
          }

          if (id.includes('/react-router/') || id.includes('/react-router-dom/')) {
            return 'vendor-router'
          }

          if (id.includes('/react-hook-form/') || id.includes('/@hookform/') || id.includes('/zod/')) {
            return 'vendor-forms'
          }

          if (id.includes('/@radix-ui/') || id.includes('/lucide-react/') || id.includes('/sonner/')) {
            return 'vendor-ui'
          }

          if (id.includes('/@visx/') || id.includes('/d3-array/')) {
            return 'vendor-charts'
          }
        },
      },
    },
  },
  // ESM worker (tinyh264.worker imports tinyh264) — 'es' format so the worker chunk
  // can code-split its static imports. Default 'iife' breaks on code-split workers.
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
})
