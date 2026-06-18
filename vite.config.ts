import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { lookup as mimeLookup } from 'mime-types'
import { resolveConfig } from './shared/config.mjs'

const tlsDir = join(homedir(), '.config/tlda')
const tlsCert = join(tlsDir, 'localhost+2.pem')
const tlsKey  = join(tlsDir, 'localhost+2-key.pem')
const hasTls = existsSync(tlsCert) && existsSync(tlsKey)

function injectedConfig() {
  const cfg = resolveConfig()
  const serverPort = process.env.VITE_SERVER_PORT
  if (!serverPort) return cfg

  const http = `${hasTls ? 'https' : 'http'}://localhost:${serverPort}`
  const ws = `${hasTls ? 'wss' : 'ws'}://localhost:${serverPort}`
  return {
    ...cfg,
    database: { http, ws },
    store: { http, ws },
  }
}

const activeConfigPlugin = {
  name: 'tlda-active-config',
  transformIndexHtml(html: string) {
    const script = `<script>window.__TLDA_CONFIG__=${JSON.stringify(injectedConfig())}</script>`
    return html.replace('</head>', `${script}\n</head>`)
  },
}

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
  plugins: [activeConfigPlugin, react(), localImagePlugin],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: true,
    port: 5179,
    ...(hasTls ? { https: { cert: readFileSync(tlsCert, 'utf8'), key: readFileSync(tlsKey, 'utf8') } } : {}),
    fs: {
      allow: ['..'],
    },
    hmr: process.env.VITE_HMR !== '1',
    watch: {
      ignored: ['**/fleet/dashboard/**'],
    },
    proxy: {
      '/ws/fleet': {
        target: `${hasTls ? 'wss' : 'ws'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`,
        ws: true,
        ...(hasTls ? { secure: false } : {}),
      },
      '/ws/terminal': {
        target: `${hasTls ? 'wss' : 'ws'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`,
        ws: true,
        ...(hasTls ? { secure: false } : {}),
      },
      '/sync': {
        target: `${hasTls ? 'wss' : 'ws'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`,
        ws: true,
        ...(hasTls ? { secure: false } : {}),
      },
      '/api': {
        target: `${hasTls ? 'https' : 'http'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`,
        ...(hasTls ? { secure: false } : {}),
      },
      '/docs': {
        target: `${hasTls ? 'https' : 'http'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`,
        ...(hasTls ? { secure: false } : {}),
      },
      '/health': {
        target: `${hasTls ? 'https' : 'http'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`,
        ...(hasTls ? { secure: false } : {}),
      },
    },
  },
  preview: {
    host: true,
    port: 5179,
    ...(hasTls ? { https: { cert: readFileSync(tlsCert, 'utf8'), key: readFileSync(tlsKey, 'utf8') } } : {}),
    proxy: {
      '/ws/fleet': { target: `${hasTls ? 'wss' : 'ws'}://localhost:5176`, ws: true, ...(hasTls ? { secure: false } : {}) },
      '/ws/terminal': { target: `${hasTls ? 'wss' : 'ws'}://localhost:5176`, ws: true, ...(hasTls ? { secure: false } : {}) },
      '/sync': { target: `${hasTls ? 'wss' : 'ws'}://localhost:5176`, ws: true, ...(hasTls ? { secure: false } : {}) },
      '/api': { target: `${hasTls ? 'https' : 'http'}://localhost:5176`, ...(hasTls ? { secure: false } : {}) },
      '/docs': { target: `${hasTls ? 'https' : 'http'}://localhost:5176`, ...(hasTls ? { secure: false } : {}) },
      '/health': { target: `${hasTls ? 'https' : 'http'}://localhost:5176`, ...(hasTls ? { secure: false } : {}) },
    },
  },
  define: {
    USE_SERVER: false,
    SYNCTEX_SERVER: JSON.stringify(''),
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
})
