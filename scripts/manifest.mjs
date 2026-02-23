/**
 * Single interface for manifest.json reads and writes.
 *
 * All scripts should use this instead of direct JSON manipulation.
 * Computes derivable fields (basePath, pages) so they can't go stale.
 *
 * Usage as module:
 *   import { readManifest, updateDoc, getDoc } from './manifest.mjs'
 *
 * Usage as CLI:
 *   node scripts/manifest.mjs get <doc>
 *   node scripts/manifest.mjs set <doc> [--pages N] [--texFile path] [--format fmt] [--sourceDoc name] [--name title]
 *   node scripts/manifest.mjs update <doc>          # recompute pages from disk
 *   node scripts/manifest.mjs list
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const MANIFEST_PATH = resolve(ROOT, 'public/docs/manifest.json')

// --- Core API ---

export function readManifest() {
  if (!existsSync(MANIFEST_PATH)) return {}
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).documents || {}
}

function writeManifest(documents) {
  writeFileSync(MANIFEST_PATH, JSON.stringify({ documents }, null, 2) + '\n')
}

/** Get a doc config with derived fields filled in. */
export function getDoc(name) {
  const docs = readManifest()
  const doc = docs[name]
  if (!doc) return null
  return enrich(name, doc)
}

/** List all docs with derived fields. */
export function listDocs() {
  const docs = readManifest()
  const result = {}
  for (const [name, doc] of Object.entries(docs)) {
    result[name] = enrich(name, doc)
  }
  return result
}

/**
 * Update a document entry. Merges with existing fields (never drops).
 * Recomputes page count from disk if pages not explicitly provided.
 */
export function updateDoc(name, fields = {}) {
  const docs = readManifest()
  const existing = docs[name] || {}

  // Merge: explicit fields override, existing fields preserved
  const merged = { ...existing, ...fields }

  // Always recompute pages from disk unless caller explicitly set them
  // and there are no files yet (first-time build, files come later)
  if (!fields.pages || fields.pages === 0) {
    const diskCount = countPagesOnDisk(name, merged.format)
    if (diskCount > 0) merged.pages = diskCount
  }

  // Strip derivable fields — they're computed at read time
  delete merged.basePath

  // Ensure name exists
  if (!merged.name) merged.name = name

  docs[name] = merged
  writeManifest(docs)
  return enrich(name, merged)
}

/** Remove a document entry. */
export function removeDoc(name) {
  const docs = readManifest()
  delete docs[name]
  writeManifest(docs)
}

// --- Derived fields ---

function enrich(name, doc) {
  return {
    ...doc,
    basePath: `/docs/${name}/`,
    // If pages is missing or 0, try to count from disk
    pages: doc.pages || countPagesOnDisk(name, doc.format) || 0,
  }
}

function countPagesOnDisk(name, format) {
  const dir = resolve(ROOT, 'public/docs', name)
  if (!existsSync(dir)) return 0
  const ext = format === 'html' ? 'html' : 'svg'
  try {
    return readdirSync(dir).filter(f => new RegExp(`^page-\\d+\\.${ext}$`).test(f)).length
  } catch {
    return 0
  }
}

// --- CLI ---

const [,, command, docName, ...rest] = process.argv
if (command) {
  switch (command) {
    case 'get': {
      if (!docName) { console.error('Usage: manifest.mjs get <doc>'); process.exit(1) }
      const doc = getDoc(docName)
      if (!doc) { console.error(`Not found: ${docName}`); process.exit(1) }
      console.log(JSON.stringify(doc, null, 2))
      break
    }
    case 'list': {
      const docs = listDocs()
      for (const [name, doc] of Object.entries(docs)) {
        const flags = [doc.format || 'svg', `${doc.pages}p`].join(', ')
        console.log(`  ${name} (${flags})`)
      }
      break
    }
    case 'set':
    case 'update': {
      if (!docName) { console.error('Usage: manifest.mjs set <doc> [--field value ...]'); process.exit(1) }
      const fields = {}
      for (let i = 0; i < rest.length; i += 2) {
        const key = rest[i].replace(/^--/, '')
        const val = rest[i + 1]
        fields[key] = key === 'pages' ? parseInt(val, 10) : val
      }
      const doc = updateDoc(docName, fields)
      console.log(JSON.stringify(doc, null, 2))
      break
    }
    default:
      console.error(`Unknown command: ${command}`)
      console.error('Commands: get, set, update, list')
      process.exit(1)
  }
}
