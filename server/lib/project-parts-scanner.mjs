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

export function recoverProjectPartsManifest(projectRoot, options = {}) {
  const scanned = scanProjectMarkdownParts(projectRoot, options)
  writeProjectPartsManifest(projectRoot, scanned.manifest)
  return scanned
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
