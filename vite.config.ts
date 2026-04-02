import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { lookup as mimeLookup } from 'mime-types'

// Dev-only plugin: serve local filesystem images for math notes
const localImagePlugin = {
  name: 'local-image',
  configureServer(server: any) {
    server.middlewares.use('/api/local-image', (req: any, res: any, next: any) => {
      const url = new URL(req.url, 'http://localhost')
      const filePath = decodeURIComponent(url.searchParams.get('path') || '')
      if (!filePath) return next()
      const expanded = filePath.startsWith('~/') ? resolve(homedir(), filePath.slice(2)) : filePath
      if (!expanded.startsWith('/') || !existsSync(expanded)) { res.statusCode = 404; res.end('Not found'); return }
      const mimeType = mimeLookup(expanded) || 'application/octet-stream'
      res.setHeader('Content-Type', mimeType)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      createReadStream(expanded).pipe(res)
    })
  },
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react(), localImagePlugin],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'fleet-dashboard': '/Users/skip/work/fleet/dashboard',
    },
  },
  server: {
    host: true,
    port: 5179,
    fs: {
      allow: ['..'],
    },
    hmr: process.env.VITE_HMR !== '1',
    watch: {
      // Don't watch the fleet dashboard — it's a runtime dep that changes at runtime,
      // and triggering HMR on every fleet event breaks playwright tests.
      ignored: ['**/fleet/dashboard/**'],
    },
    proxy: {
      // Fleet WebSocket endpoint
      '/ws/fleet': {
        target: 'ws://localhost:5199',
        ws: true,
      },
      // tlda-specific API routes → tlda server
      '/api/projects': 'http://localhost:5176',
      '/api/auth': 'http://localhost:5176',
      '/api/recognize': 'http://localhost:5176',
      '/api/local-image': 'http://localhost:5176',
      // Remaining /api/* → fleet server (state, chat, activity, etc.)
      '/api': 'http://localhost:5199',
      '/docs': 'http://localhost:5176',
      '/health': 'http://localhost:5176',
    },
  },
  preview: {
    host: true,
    port: 5179,
    proxy: {
      '/ws/fleet': { target: 'ws://localhost:5199', ws: true },
      '/api/projects': 'http://localhost:5176',
      '/api/auth': 'http://localhost:5176',
      '/api/recognize': 'http://localhost:5176',
      '/api/local-image': 'http://localhost:5176',
      '/api': 'http://localhost:5199',
      '/docs': 'http://localhost:5176',
      '/health': 'http://localhost:5176',
    },
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
})
