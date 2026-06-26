import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { extname, join, posix } from 'path'

const LOCAL_SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const HTML_ATTR_RE = /\b(?:src|href|poster|data-src|data-background(?:-image|-video|-iframe)?)\s*=\s*(["'])(.*?)\1/gi
const SRCSET_RE = /\bsrcset\s*=\s*(["'])(.*?)\1/gi
const STYLE_ATTR_RE = /\bstyle\s*=\s*(["'])(.*?)\1/gi
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/gi
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^'")\s;]+))/gi

function stripUrlSuffix(ref) {
  return ref.split('#', 1)[0].split('?', 1)[0]
}

function decodeUrlPath(ref) {
  try {
    return decodeURIComponent(ref)
  } catch (error) {
    if (error instanceof URIError) return ref
    throw error
  }
}

function normalizeLocalRef(fromRel, ref) {
  let clean = stripUrlSuffix(String(ref || '').trim())
  if (!clean || clean.startsWith('#') || clean.startsWith('/') || LOCAL_SCHEME_RE.test(clean)) return null
  clean = decodeUrlPath(clean)
  const base = posix.dirname(fromRel)
  const rel = posix.normalize(base === '.' ? clean : posix.join(base, clean))
  if (rel === '.' || rel === '..' || rel.startsWith('../')) return null
  return rel
}

function pathOnDisk(root, rel) {
  return join(root, ...rel.split('/'))
}

function maybeQueue(root, queue, seen, missing, fromRel, ref) {
  const rel = normalizeLocalRef(fromRel, ref)
  if (!rel || seen.has(rel)) return
  const abs = pathOnDisk(root, rel)
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    missing.add(rel)
    return
  }
  queue.push(rel)
}

function refsFromSrcset(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim().split(/\s+/, 1)[0])
    .filter(Boolean)
}

function collectCssRefs(text) {
  const refs = []
  let match
  CSS_URL_RE.lastIndex = 0
  while ((match = CSS_URL_RE.exec(text))) refs.push(match[1] || match[2] || match[3])
  CSS_IMPORT_RE.lastIndex = 0
  while ((match = CSS_IMPORT_RE.exec(text))) refs.push(match[1] || match[2] || match[3])
  return refs
}

function htmlWithoutScriptBodies(text) {
  return text.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, '<script$1></script>')
}

function collectRefs(root, rel) {
  const abs = pathOnDisk(root, rel)
  const ext = extname(rel).toLowerCase()
  if (!['.html', '.htm', '.css'].includes(ext)) return []

  const text = readFileSync(abs, 'utf8')
  const refs = []
  let match

  if (ext === '.html' || ext === '.htm') {
    const attrText = htmlWithoutScriptBodies(text)
    HTML_ATTR_RE.lastIndex = 0
    while ((match = HTML_ATTR_RE.exec(attrText))) refs.push(match[2])
    SRCSET_RE.lastIndex = 0
    while ((match = SRCSET_RE.exec(attrText))) refs.push(...refsFromSrcset(match[2]))
    STYLE_ATTR_RE.lastIndex = 0
    while ((match = STYLE_ATTR_RE.exec(attrText))) refs.push(...collectCssRefs(match[2]))
    STYLE_BLOCK_RE.lastIndex = 0
    while ((match = STYLE_BLOCK_RE.exec(text))) refs.push(...collectCssRefs(match[1]))
  } else {
    refs.push(...collectCssRefs(text))
  }

  return refs
}

function readArtifactFile(root, rel) {
  return {
    path: rel,
    content: readFileSync(pathOnDisk(root, rel)).toString('base64'),
    encoding: 'base64',
  }
}

export function htmlArtifactMainForSource(mainFile) {
  return mainFile?.replace(/\.(?:qmd|md|ipynb)$/i, '.html') || null
}

export function collectHtmlArtifactFiles(root, { mainFile = null } = {}) {
  const entryFiles = mainFile
    ? [mainFile]
    : readdirSync(root).filter(f => /\.(?:html|htm)$/i.test(f) && !f.startsWith('_')).sort()

  const queue = []
  const seen = new Set()
  const missing = new Set()
  for (const rel of entryFiles) {
    const normalized = posix.normalize(rel)
    const abs = pathOnDisk(root, normalized)
    if (existsSync(abs) && statSync(abs).isFile()) queue.push(normalized)
    else missing.add(normalized)
  }

  const ordered = []
  while (queue.length > 0) {
    const rel = queue.shift()
    if (seen.has(rel)) continue
    seen.add(rel)
    ordered.push(rel)
    for (const ref of collectRefs(root, rel)) {
      maybeQueue(root, queue, seen, missing, rel, ref)
    }
  }

  return {
    files: ordered.map(rel => readArtifactFile(root, rel)),
    paths: ordered,
    entryFiles,
    missing: [...missing].sort(),
  }
}
