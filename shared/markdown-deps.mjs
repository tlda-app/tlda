// markdown-deps.mjs — the SHARED markdown dependency detector.
//
// "Uploading a markdown file should upload its includes." A markdown file is not
// a single file — it is the transitive closure of local Markdown links and local
// assets rooted at the project's main file. This is
// the one place that answers "what does this markdown file include," used by:
//   - chat file-share (mcp-server): upload the deps, rewrite refs to served URLs
//   - the markdown doc push (cli/tlda.mjs): send main + deps to the server
//   - the fleet daemon watcher (bin/fleet-daemon.mjs): watch/bundle just the deps,
//     not the whole sourceDir
//
// Pure (content + base dir in → refs out), so it runs wherever it's needed —
// crucially on the AGENT's machine for the daemon, where server build output
// (relevant-files.json) doesn't exist. Mirror of the server's own ref-scan in
// build-markdown.mjs (which keep in sync if these patterns change).
import path from 'path'
import os from 'os'
import fs from 'fs'
import { readFile, stat } from 'fs/promises'
import { isSourceFilePath } from './source-manifest.mjs'

const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g
const MD_LINK_RE = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g
const HTML_IMG_RE = /<img\s[^>]*\bsrc=["']([^"']+)["']/g
const HTML_LINK_RE = /<a\s[^>]*\bhref=["']([^"']+)["']/g

// True for refs we must NOT treat as local files: remote URLs, data URIs,
// protocol-relative URLs.
function isExternal(ref) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)
}

function resolveRef(ref, baseDir) {
  const expanded = ref.replace(/^~\//, os.homedir() + '/')
  if (path.isAbsolute(expanded)) return expanded
  return baseDir ? path.resolve(baseDir, expanded) : null
}

// Scan markdown source for locally-referenced dependencies (images today).
// Returns [{ ref, abs }] — `ref` is the path exactly as written (for rewriting
// the rendered body or as the server-side relative push key); `abs` is the
// resolved absolute path (baseDir-relative), or null when it can't be resolved.
// External refs (http/data///) are skipped entirely. Deduped by `ref`.
export function scanMarkdownDeps(content, baseDir) {
  if (!content) return []
  const seen = new Set()
  const deps = []
  const collect = (re) => {
    for (const m of content.matchAll(re)) {
      const raw = m[1].trim()
      const target = raw.startsWith('<') && raw.includes('>')
        ? raw.slice(1, raw.indexOf('>'))
        : raw.split(/\s+["'(]/, 1)[0]
      const ref = target.split(/[#?]/)[0].trim()
      if (!ref || isExternal(ref) || seen.has(ref)) continue
      seen.add(ref)
      deps.push({ ref, abs: resolveRef(ref, baseDir) })
    }
  }
  collect(MD_IMAGE_RE)
  collect(MD_LINK_RE)
  collect(HTML_IMG_RE)
  collect(HTML_LINK_RE)
  return deps
}

function projectRelativeRef(raw) {
  const ref = String(raw || '').split(/[#?]/)[0].trim().replace(/^<|>$/g, '')
  if (!ref || isExternal(ref) || ref.startsWith('/') || ref.startsWith('~/')) return null
  return ref.replace(/\\/g, '/')
}

function isMarkdownPath(file) {
  return /\.(?:md|markdown)$/i.test(file)
}

export function scanMarkdownDependencyClosure(mainFile, sourceDir) {
  const root = path.resolve(sourceDir)
  const main = String(mainFile || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const markdown = new Set()
  const assets = new Set()
  const missing = []
  const queue = [main]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || markdown.has(current)) continue
    const abs = path.resolve(root, current)
    const rel = path.relative(root, abs).replace(/\\/g, '/')
    if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) continue
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      missing.push({ from: current, ref: current, path: rel })
      continue
    }
    markdown.add(rel)
    const content = fs.readFileSync(abs, 'utf8')
    for (const dep of scanMarkdownDeps(content, path.dirname(abs))) {
      const ref = projectRelativeRef(dep.ref)
      if (!ref) continue
      const targetAbs = path.resolve(path.dirname(abs), ref)
      const targetRel = path.relative(root, targetAbs).replace(/\\/g, '/')
      if (!targetRel || targetRel.startsWith('../') || path.isAbsolute(targetRel)) continue
      if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
        missing.push({ from: rel, ref: dep.ref, path: targetRel })
        continue
      }
      if (isMarkdownPath(targetRel)) {
        if (!markdown.has(targetRel)) queue.push(targetRel)
      } else if (isSourceFilePath(targetRel, { format: 'markdown', mainFile: main })) {
        assets.add(targetRel)
      }
    }
  }

  return {
    mainFile: main,
    markdown: [...markdown].sort(),
    assets: [...assets].sort(),
    files: [...markdown, ...assets].sort(),
    missing,
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function scanMarkdownDependencyClosureAsync(mainFile, sourceDir) {
  const root = path.resolve(sourceDir)
  const main = String(mainFile || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const markdown = new Set()
  const assets = new Set()
  const missing = []
  const queue = [main]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || markdown.has(current)) continue
    const abs = path.resolve(root, current)
    const rel = path.relative(root, abs).replace(/\\/g, '/')
    if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) continue
    if (!await isFile(abs)) {
      missing.push({ from: current, ref: current, path: rel })
      continue
    }
    markdown.add(rel)
    const content = await readFile(abs, 'utf8')
    for (const dep of scanMarkdownDeps(content, path.dirname(abs))) {
      const ref = projectRelativeRef(dep.ref)
      if (!ref) continue
      const targetAbs = path.resolve(path.dirname(abs), ref)
      const targetRel = path.relative(root, targetAbs).replace(/\\/g, '/')
      if (!targetRel || targetRel.startsWith('../') || path.isAbsolute(targetRel)) continue
      if (!await isFile(targetAbs)) {
        missing.push({ from: rel, ref: dep.ref, path: targetRel })
        continue
      }
      if (isMarkdownPath(targetRel)) {
        if (!markdown.has(targetRel)) queue.push(targetRel)
      } else if (isSourceFilePath(targetRel, { format: 'markdown', mainFile: main })) {
        assets.add(targetRel)
      }
    }
  }

  return {
    mainFile: main,
    markdown: [...markdown].sort(),
    assets: [...assets].sort(),
    files: [...markdown, ...assets].sort(),
    missing,
  }
}
