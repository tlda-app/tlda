import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, relative, sep } from 'path'
import {
  DEFAULT_PART_DIRS,
  PROJECT_PARTS_MANIFEST_FILE,
  createProjectPartRecord,
  createProjectPartsManifest,
  isValidPartId,
  normalizeProjectPartsManifest,
  parseMarkdownPart,
} from '../../shared/project-parts.mjs'

const MARKDOWN_EXT_RE = /\.(md|markdown)$/i

export function scanProjectMarkdownParts(projectRoot, { managedDirs = DEFAULT_PART_DIRS } = {}) {
  const parts = []
  const errors = []
  const seenIds = new Map()

  for (const dir of managedDirs) {
    const fullDir = join(projectRoot, dir)
    if (!existsSync(fullDir)) continue

    for (const fullPath of walkMarkdownFiles(fullDir)) {
      const path = normalizeProjectPath(relative(projectRoot, fullPath))
      let parsed
      try {
        parsed = parseMarkdownPart(readFileSync(fullPath, 'utf8'))
      } catch (e) {
        errors.push({ path, error: e.message })
        continue
      }

      if (!parsed.id) continue
      if (!isValidPartId(parsed.id)) {
        errors.push({ path, id: parsed.id, error: 'Invalid tlda-id' })
        continue
      }
      if (parsed.errors.length) {
        errors.push({ path, id: parsed.id, error: parsed.errors.join('; ') })
        continue
      }
      if (seenIds.has(parsed.id)) {
        errors.push({ path, id: parsed.id, duplicateOf: seenIds.get(parsed.id), error: 'Duplicate tlda-id' })
        continue
      }

      seenIds.set(parsed.id, path)
      parts.push(createProjectPartRecord({
        id: parsed.id,
        kind: parsed.kind || 'text',
        path,
        title: parsed.title,
        storage: { type: 'project', path },
      }))
    }
  }

  parts.sort((a, b) => a.path.localeCompare(b.path))
  return { parts, errors, manifest: createProjectPartsManifest(parts) }
}

export function projectPartsManifestPath(projectRoot) {
  return join(projectRoot, '.tlda', PROJECT_PARTS_MANIFEST_FILE)
}

export function readProjectPartsManifest(projectRoot) {
  const path = projectPartsManifestPath(projectRoot)
  if (!existsSync(path)) return createProjectPartsManifest()
  return normalizeProjectPartsManifest(JSON.parse(readFileSync(path, 'utf8')))
}

export function writeProjectPartsManifest(projectRoot, manifest) {
  const path = projectPartsManifestPath(projectRoot)
  const normalized = normalizeProjectPartsManifest(manifest)
  return writeManifestFile(path, normalized)
}

export function upsertProjectPartsManifest(projectRoot, parts, options = {}) {
  const current = readProjectPartsManifest(projectRoot)
  const updates = (Array.isArray(parts) ? parts : [parts])
    .filter(Boolean)
    .map(part => createProjectPartRecord(part))
  const byId = new Map(current.parts.map(part => [part.id, part]))
  for (const part of updates) {
    const existing = byId.get(part.id)
    byId.set(part.id, mergeProjectPartRecord(existing, part))
  }
  const externalAuthorities = mergeExternalAuthorities(
    current.externalAuthorities,
    options.externalAuthorities,
  )
  const manifest = createProjectPartsManifest(
    [...byId.values()].sort(comparePartRecords),
    { externalAuthorities },
  )
  return writeProjectPartsManifest(projectRoot, manifest)
}

export function recoverProjectPartsManifest(projectRoot, options = {}) {
  const scanned = scanProjectMarkdownParts(projectRoot, options)
  writeProjectPartsManifest(projectRoot, scanned.manifest)
  return scanned
}

function mergeProjectPartRecord(existing, update) {
  if (!existing) return update
  return {
    ...existing,
    ...update,
    metadata: mergeObjects(existing.metadata, update.metadata),
    authority: mergeObjects(existing.authority, update.authority),
    storage: mergeObjects(existing.storage, update.storage),
  }
}

function mergeObjects(existing, update) {
  if (!existing && !update) return undefined
  return {
    ...(existing || {}),
    ...(update || {}),
  }
}

function mergeExternalAuthorities(existing = [], updates = []) {
  const result = []
  const seen = new Set()
  for (const authority of [...existing, ...updates]) {
    if (!authority || typeof authority !== 'object') continue
    const key = JSON.stringify(authority)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(authority)
  }
  return result
}

function comparePartRecords(a, b) {
  return String(a.path || '').localeCompare(String(b.path || '')) || String(a.id).localeCompare(String(b.id))
}

function walkMarkdownFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(full))
    } else if (entry.isFile() && MARKDOWN_EXT_RE.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

function normalizeProjectPath(path) {
  return path.split(sep).join('/')
}

function writeManifestFile(path, manifest) {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
