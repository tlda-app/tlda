/**
 * Data source abstraction for MCP server.
 *
 * When CTD_SERVER is set: fetches doc assets from the server over HTTP.
 * Otherwise: reads from PROJECT_ROOT/public/docs/ (backward compat).
 *
 * Provides both sync (from cache/disk) and async (fetch + cache) APIs.
 * Call ensureDoc(docName) at the start of tool handlers to pre-fetch.
 */

import fs from 'fs'
import path from 'path'

let projectRoot = null
let serverUrl = null

// In-memory cache: docName → { filename → { data, fetchedAt } }
const cache = new Map()
const CACHE_TTL = {
  'lookup.json': 30_000,       // 30s — changes on rebuild
  'macros.json': 300_000,      // 5min — rarely changes
  'proof-info.json': 300_000,  // 5min
  'page-info.json': 300_000,   // 5min
  'search-index.json': 300_000, // 5min
  'manifest.json': 30_000,    // 30s
}
const DEFAULT_TTL = 60_000 // 1min for unknown files

export function initDataSource(root, server) {
  projectRoot = root
  serverUrl = server || null
}

export function isRemote() {
  return !!serverUrl
}

/**
 * Get the local path for a doc file. Returns null if remote-only.
 * Checks both public/docs/ (legacy) and server/projects/{name}/output/.
 */
export function localPath(docName, filename) {
  if (!projectRoot) return null
  const publicPath = path.join(projectRoot, 'public', 'docs', docName, filename)
  if (fs.existsSync(publicPath)) return publicPath
  const serverPath = path.join(projectRoot, 'server', 'projects', docName, 'output', filename)
  if (fs.existsSync(serverPath)) return serverPath
  return publicPath // default for cache miss / new files
}

/**
 * Get the local doc directory path. Returns null if remote-only.
 * Checks both public/docs/ and server/projects/{name}/output/.
 */
export function localDocDir(docName) {
  if (!projectRoot) return null
  const publicDir = path.join(projectRoot, 'public', 'docs', docName)
  if (fs.existsSync(publicDir)) return publicDir
  const serverDir = path.join(projectRoot, 'server', 'projects', docName, 'output')
  if (fs.existsSync(serverDir)) return serverDir
  return publicDir
}

/**
 * Read a JSON file for a doc. Sync — reads from disk or cache.
 * Returns parsed JSON or null.
 */
export function readJsonSync(docName, filename) {
  // Check cache first (used for both remote and local)
  const cached = getCached(docName, filename)
  if (cached !== undefined) return cached

  if (serverUrl) {
    // Remote mode: must pre-fetch with ensureJson()
    return null
  }

  // Local mode: read from disk with mtime caching
  return readJsonFromDisk(docName, filename)
}

/**
 * Read a JSON file, fetching from server if needed. Async.
 */
export async function readJson(docName, filename) {
  // Check cache
  const cached = getCached(docName, filename)
  if (cached !== undefined) return cached

  if (serverUrl) {
    return await fetchJson(docName, filename)
  }

  return readJsonFromDisk(docName, filename)
}

/**
 * Read the manifest. Sync from cache/disk, async for remote.
 */
export function readManifestSync() {
  if (serverUrl) {
    const cached = getCached('_root', 'manifest.json')
    if (cached !== undefined) return cached
    return null
  }

  const manifestPath = path.join(projectRoot, 'public', 'docs', 'manifest.json')
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch {
    return null
  }
}

export async function readManifest() {
  if (serverUrl) {
    const cached = getCached('_root', 'manifest.json')
    if (cached !== undefined) return cached

    try {
      const res = await fetch(`${serverUrl}/docs/manifest.json`)
      if (!res.ok) return null
      const data = await res.json()
      setCache('_root', 'manifest.json', data)
      return data
    } catch {
      return null
    }
  }

  return readManifestSync()
}

/**
 * Read a text file (e.g. SVG) for a doc. Sync only (no HTTP fetch for SVGs).
 * For remote mode, SVGs should be pre-fetched or accessed differently.
 */
export function readTextSync(docName, filename) {
  const cached = getCached(docName, filename)
  if (cached !== undefined) return cached

  if (serverUrl) return null

  const filePath = localPath(docName, filename)
  if (!filePath) return null
  try {
    const data = fs.readFileSync(filePath, 'utf8')
    setCache(docName, filename, data)
    return data
  } catch {
    return null
  }
}

/**
 * Read a text file, fetching from server if needed. Async.
 */
export async function readText(docName, filename) {
  const cached = getCached(docName, filename)
  if (cached !== undefined) return cached

  if (serverUrl) {
    try {
      const res = await fetch(`${serverUrl}/docs/${docName}/${filename}`)
      if (!res.ok) return null
      const data = await res.text()
      setCache(docName, filename, data)
      return data
    } catch {
      return null
    }
  }

  return readTextSync(docName, filename)
}

/**
 * Pre-fetch commonly needed files for a doc. Call at start of tool handlers.
 */
export async function ensureDoc(docName) {
  if (!serverUrl) return // disk mode — no pre-fetch needed

  await Promise.all([
    readJson(docName, 'lookup.json'),
    readManifest(),
  ])
}

// ---- Internal ----

function getCached(docName, filename) {
  const docCache = cache.get(docName)
  if (!docCache) return undefined
  const entry = docCache.get(filename)
  if (!entry) return undefined
  const ttl = CACHE_TTL[filename] || DEFAULT_TTL
  if (Date.now() - entry.fetchedAt > ttl) {
    docCache.delete(filename)
    return undefined
  }
  return entry.data
}

function setCache(docName, filename, data) {
  if (!cache.has(docName)) cache.set(docName, new Map())
  cache.get(docName).set(filename, { data, fetchedAt: Date.now() })
}

function readJsonFromDisk(docName, filename) {
  const filePath = localPath(docName, filename)
  if (!filePath) return null
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    setCache(docName, filename, data)
    return data
  } catch {
    return null
  }
}

async function fetchJson(docName, filename) {
  try {
    const res = await fetch(`${serverUrl}/docs/${docName}/${filename}`)
    if (!res.ok) return null
    const data = await res.json()
    setCache(docName, filename, data)
    return data
  } catch {
    return null
  }
}
