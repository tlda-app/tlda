import { parseDocument } from 'yaml'

export const PROJECT_PARTS_MANIFEST_VERSION = 1
export const DEFAULT_PART_DIRS = ['notes', 'parts']
export const DEFAULT_PART_TITLE = 'untitled note'
export const PROJECT_PARTS_MANIFEST_FILE = 'parts.json'

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function parseMarkdownPart(source, { contextualTitle = null } = {}) {
  const text = String(source ?? '')
  const { data, body, hasFrontmatter, errors } = parseFrontmatter(text)
  const id = normalizeScalar(data?.['tlda-id'])
  const kind = normalizeScalar(data?.['tlda-kind']) || null
  const title = titleFromMarkdownBody(body, { contextualTitle })

  return {
    id,
    kind,
    title,
    body,
    frontmatter: data,
    hasFrontmatter,
    errors,
    valid: Boolean(id) && errors.length === 0,
  }
}

export function isValidPartId(id) {
  return typeof id === 'string' && UUID_RE.test(id)
}

export function partTitleFallback(body, options = {}) {
  return titleFromMarkdownBody(String(body ?? ''), options)
}

export function createProjectPartRecord({
  id,
  kind,
  path,
  title,
  storage = null,
  authority = null,
  metadata = {},
}) {
  if (!id) throw new Error('Project part record requires id')
  const projectPath = path || storage?.path || null
  return {
    id,
    kind: kind || 'text',
    title: title || DEFAULT_PART_TITLE,
    storage: storage || { type: 'project', path: projectPath },
    ...(projectPath ? { path: projectPath } : {}),
    ...(authority ? { authority } : {}),
    ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
  }
}

export function createProjectPartsManifest(parts = [], { externalAuthorities = [] } = {}) {
  return {
    version: PROJECT_PARTS_MANIFEST_VERSION,
    parts: parts.map(part => createProjectPartRecord(part)),
    externalAuthorities,
  }
}

export function normalizeProjectPartsManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return createProjectPartsManifest()
  }
  return createProjectPartsManifest(
    Array.isArray(manifest.parts) ? manifest.parts : [],
    { externalAuthorities: Array.isArray(manifest.externalAuthorities) ? manifest.externalAuthorities : [] },
  )
}

function parseFrontmatter(source) {
  const match = source.match(FRONTMATTER_RE)
  if (!match) return { data: {}, body: source, hasFrontmatter: false, errors: [] }

  const errors = []
  let data = {}
  try {
    const doc = parseDocument(match[1])
    if (doc.errors.length) {
      errors.push(...doc.errors.map(e => e.message))
    } else {
      const parsed = doc.toJSON()
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    }
  } catch (e) {
    errors.push(e.message)
  }

  return {
    data,
    body: source.slice(match[0].length),
    hasFrontmatter: true,
    errors,
  }
}

function normalizeScalar(value) {
  if (value == null) return null
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function titleFromMarkdownBody(body, { contextualTitle = null } = {}) {
  const lines = String(body ?? '').split(/\r?\n/)
  for (const line of lines) {
    const heading = line.match(/^#\s+(.+?)\s*$/)
    if (heading) return cleanupTitle(heading[1])
  }
  for (const line of lines) {
    const cleaned = cleanupTitle(line)
    if (cleaned) return cleaned
  }
  return contextualTitle || DEFAULT_PART_TITLE
}

function cleanupTitle(line) {
  return String(line ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\s*\{#[\w-]+\}\s*$/, '')
    .replace(/[*_`~[\]()]/g, '')
    .trim()
}
