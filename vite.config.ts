import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { createReadStream, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { lookup as mimeLookup } from 'mime-types'
import { resolveConfig } from './shared/config.mjs'

const tlsDir = join(homedir(), '.config/tlda')
const tlsCert = join(tlsDir, 'localhost+2.pem')
const tlsKey  = join(tlsDir, 'localhost+2-key.pem')
const hasLocalTls = process.env.TLDA_VITE_HTTP !== '1' && existsSync(tlsCert) && existsSync(tlsKey)
const tldrawForkPackages = resolve('./tldraw-fork/packages')
const hasTldrawForkSources = existsSync(resolve(tldrawForkPackages, 'tldraw/src/index.ts'))

const tldrawForkAliases = hasTldrawForkSources ? [
  { find: /^tldraw$/, replacement: resolve(tldrawForkPackages, 'tldraw/src/index.ts') },
  { find: /^tldraw\/tldraw\.css$/, replacement: resolve(tldrawForkPackages, 'tldraw/tldraw.css') },
  { find: /^@tldraw\/driver$/, replacement: resolve(tldrawForkPackages, 'driver/src/index.ts') },
  { find: /^@tldraw\/editor$/, replacement: resolve(tldrawForkPackages, 'editor/src/index.ts') },
  { find: /^@tldraw\/state$/, replacement: resolve(tldrawForkPackages, 'state/src/index.ts') },
  { find: /^@tldraw\/state-react$/, replacement: resolve(tldrawForkPackages, 'state-react/src/index.ts') },
  { find: /^@tldraw\/store$/, replacement: resolve(tldrawForkPackages, 'store/src/index.ts') },
  { find: /^@tldraw\/sync$/, replacement: resolve(tldrawForkPackages, 'sync/src/index.ts') },
  { find: /^@tldraw\/sync-core$/, replacement: resolve(tldrawForkPackages, 'sync-core/src/index.ts') },
  { find: /^@tldraw\/tlschema$/, replacement: resolve(tldrawForkPackages, 'tlschema/src/index.ts') },
  { find: /^@tldraw\/utils$/, replacement: resolve(tldrawForkPackages, 'utils/src/index.ts') },
  { find: /^@tldraw\/validate$/, replacement: resolve(tldrawForkPackages, 'validate/src/index.ts') },
  { find: /^rbush$/, replacement: resolve('node_modules/rbush/index.js') },
] : []

function injectedConfig(hasTls: boolean) {
  const cfg = resolveConfig()
  const serverPort = process.env.VITE_SERVER_PORT
  if (!serverPort) return cfg

  const serverHost = process.env.VITE_SERVER_HOST || 'localhost'
  const http = `${hasTls ? 'https' : 'http'}://${serverHost}:${serverPort}`
  const ws = `${hasTls ? 'wss' : 'ws'}://${serverHost}:${serverPort}`
  return {
    ...cfg,
    database: { http, ws },
    store: { http, ws },
  }
}

function wsFromHttp(http: string) {
  return http.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')
}

function proxyTargets(hasTls: boolean) {
  if (process.env.TLDA_VITE_PROXY_ACTIVE_CONFIG === '1') {
    const cfg = resolveConfig()
    return {
      databaseHttp: cfg.database.http,
      databaseWs: cfg.database.ws || wsFromHttp(cfg.database.http),
      storeHttp: cfg.store.http,
      storeWs: cfg.store.ws || wsFromHttp(cfg.store.http),
      changeOrigin: true,
      secure: false,
    }
  }

  const localHttp = `${hasTls ? 'https' : 'http'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`
  const localWs = `${hasTls ? 'wss' : 'ws'}://localhost:${process.env.VITE_SERVER_PORT || 5176}`
  return {
    databaseHttp: localHttp,
    databaseWs: localWs,
    storeHttp: localHttp,
    storeWs: localWs,
    changeOrigin: false,
    secure: !hasTls,
  }
}

const activeConfigPlugin = {
  name: 'tlda-active-config',
  transformIndexHtml(html: string) {
    const script = `<script>window.__TLDA_CONFIG__=${JSON.stringify(injectedConfig(hasLocalTls))}</script>`
    return html.replace('</head>', `${script}\n</head>`)
  },
}

function localTlsHttps() {
  if (!hasLocalTls) return {}
  return { https: { cert: readFileSync(tlsCert, 'utf8'), key: readFileSync(tlsKey, 'utf8') } }
}

function readAppBuildInfo() {
  try {
    const raw = readFileSync(resolve('server/build-info.json'), 'utf8')
    const info = JSON.parse(raw)
    const sha = typeof info.gitSha === 'string' && info.gitSha
      ? info.gitSha
      : typeof info.sha === 'string' && info.sha
        ? info.sha
        : null
    if (!sha) return null
    return {
      gitSha: sha,
      sha,
      ref: typeof info.ref === 'string' ? info.ref : null,
      branch: typeof info.branch === 'string' ? info.branch : null,
      dirty: Boolean(info.dirty),
      builtAt: typeof info.builtAt === 'string' ? info.builtAt : null,
    }
  } catch {
    try {
      const git = (args: string) => execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      const sha = git('rev-parse HEAD')
      const branch = git('rev-parse --abbrev-ref HEAD')
      const dirty = git('status --porcelain').length > 0
      return {
        gitSha: sha,
        sha,
        ref: branch && branch !== 'HEAD' ? branch : `detached:${sha.slice(0, 12)}`,
        branch: branch && branch !== 'HEAD' ? branch : null,
        dirty,
        builtAt: new Date().toISOString(),
      }
    } catch {
      return null
    }
  }
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
export default defineConfig(({ command }) => {
const hasTls = command === 'serve' && hasLocalTls
const proxies = proxyTargets(hasTls)
return {
  base: process.env.VITE_BASE_PATH || '/',
  esbuild: {
    keepNames: true,
  },
  plugins: [
    activeConfigPlugin,
    react({
      babel: {
        plugins: [['@babel/plugin-proposal-decorators', { version: '2023-11' }]],
      },
    }),
    localImagePlugin,
  ],
  resolve: {
    alias: tldrawForkAliases,
    dedupe: ['react', 'react-dom'],
  },
  build: {
    sourcemap: true,
  },
  server: {
    host: true,
    port: 5179,
    ...(hasTls ? localTlsHttps() : {}),
    fs: {
      allow: hasTldrawForkSources ? ['..', resolve('./tldraw-fork')] : ['..'],
    },
    hmr: process.env.VITE_HMR !== '1',
    watch: {
      ignored: ['**/fleet/dashboard/**'],
    },
    proxy: {
      '/ws/fleet': {
        target: proxies.databaseWs,
        ws: true,
        changeOrigin: proxies.changeOrigin,
        secure: proxies.secure,
      },
      '/ws/terminal': {
        target: proxies.databaseWs,
        ws: true,
        changeOrigin: proxies.changeOrigin,
        secure: proxies.secure,
      },
      '/sync': {
        target: proxies.storeWs,
        ws: true,
        changeOrigin: proxies.changeOrigin,
        secure: proxies.secure,
      },
      '/api': {
        target: proxies.storeHttp,
        changeOrigin: proxies.changeOrigin,
        secure: proxies.secure,
      },
      '/docs': {
        target: proxies.storeHttp,
        changeOrigin: proxies.changeOrigin,
        secure: proxies.secure,
      },
      '/health': {
        target: proxies.storeHttp,
        changeOrigin: proxies.changeOrigin,
        secure: proxies.secure,
      },
    },
  },
  preview: {
    host: true,
    port: 5179,
    ...(hasTls ? localTlsHttps() : {}),
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
    __TLDA_APP_BUILD_INFO__: JSON.stringify(readAppBuildInfo()),
  },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
}
})
