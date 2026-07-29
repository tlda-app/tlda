import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

import { scanMarkdownDeps } from './markdown-deps.mjs'
import { parseMarkdownDocument, parsePandocAttrs } from './markdown-selector.mjs'

const MARKDOWN_RE = /\.(?:md|markdown)$/i
const CODE_FENCE_OPEN_RE = /^(\s*)(`{3,}|~{3,})(.*)$/

function flatten(node) {
  const out = []
  for (const child of node.children || []) out.push(child, ...flatten(child))
  return out
}

function volatileCodeFenceRanges(lines) {
  const ranges = []
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(CODE_FENCE_OPEN_RE)
    if (!open) continue
    const attrs = parsePandocAttrs(open[3])
    const marker = open[2][0]
    const width = open[2].length
    let end = i + 1
    while (end < lines.length && !new RegExp(`^\\s*${marker}{${width},}\\s*$`).test(lines[end])) end++
    end = Math.min(lines.length, end + 1)
    if (attrs.classes.includes('volatile')) ranges.push({ start: i, end })
    i = end - 1
  }
  return ranges
}

export function volatileMarkdownRanges(content) {
  const source = String(content ?? '')
  const lines = source.split('\n')
  const structural = flatten(parseMarkdownDocument(source))
    .filter(node => node.classes?.includes('volatile'))
    .map(node => ({ start: node.start, end: node.end }))
  const ranges = [...structural, ...volatileCodeFenceRanges(lines)]
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const outermost = []
  for (const range of ranges) {
    if (outermost.some(parent => range.start >= parent.start && range.end <= parent.end)) continue
    outermost.push(range)
  }
  return outermost
}

export function maskVolatileMarkdown(content) {
  const lines = String(content ?? '').split('\n')
  for (const range of volatileMarkdownRanges(content).sort((a, b) => b.start - a.start)) {
    lines.splice(range.start, range.end - range.start, '<!-- tlda:volatile -->')
  }
  return lines.join('\n')
}

export function stripVolatileMarkdownMarkersForRender(content) {
  const lines = String(content ?? '').split('\n')
  const divStack = []
  let inCodeFence = false
  let codeFenceMarker = null
  let codeFenceWidth = 0
  return lines.map(line => {
    const fence = line.match(CODE_FENCE_OPEN_RE)
    if (fence) {
      if (!inCodeFence) {
        inCodeFence = true
        codeFenceMarker = fence[2][0]
        codeFenceWidth = fence[2].length
        const attrs = parsePandocAttrs(fence[3])
        if (attrs.classes.includes('volatile')) {
          return `${fence[1]}${fence[2]}${fence[3].slice(0, -attrs.raw.length).trimEnd()}`
        }
      } else if (
        fence[2][0] === codeFenceMarker &&
        fence[2].length >= codeFenceWidth &&
        !fence[3].trim()
      ) {
        inCodeFence = false
      }
      return line
    }
    if (inCodeFence) return line

    const divOpen = line.match(/^\s*:::\s*(\{[^}]*\})\s*$/)
    if (divOpen) {
      const isVolatile = parsePandocAttrs(divOpen[1]).classes.includes('volatile')
      divStack.push(isVolatile)
      return isVolatile ? '' : line
    }
    if (/^\s*:::\s*$/.test(line) && divStack.length) {
      return divStack.pop() ? '' : line
    }
    if (/^#{1,6}\s+/.test(line)) {
      const attrs = parsePandocAttrs(line)
      if (attrs.classes.includes('volatile')) return line.slice(0, -attrs.raw.length).trimEnd()
    }
    return line
  }).join('\n')
}

function projectRelativeDependency(dep, root) {
  if (!dep.abs) return null
  const rel = path.relative(root, dep.abs).replace(/\\/g, '/')
  if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) return null
  return rel
}

async function fileExists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function hashFile(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

export async function markdownVersionTriggerProjection({ root, mainFile, files }) {
  const sourceRoot = path.resolve(root)
  const allowed = new Set((files || []).map(file => String(file).replace(/\\/g, '/')))
  const states = new Map()
  const queue = []
  const mark = (file, kind) => {
    if (!allowed.has(file)) return
    const state = states.get(file) || { nonvolatile: false, volatile: false }
    if (state[kind]) return
    state[kind] = true
    states.set(file, state)
    queue.push(file)
  }
  mark(String(mainFile || '').replace(/\\/g, '/'), 'nonvolatile')

  while (queue.length) {
    const rel = queue.shift()
    const state = states.get(rel)
    if (!state || !MARKDOWN_RE.test(rel)) continue
    const abs = path.join(sourceRoot, rel)
    if (!await fileExists(abs)) continue
    const content = await readFile(abs, 'utf8')
    const allDeps = new Set(scanMarkdownDeps(content, path.dirname(abs))
      .map(dep => projectRelativeDependency(dep, sourceRoot))
      .filter(Boolean))
    const nonvolatileDeps = state.nonvolatile
      ? new Set(scanMarkdownDeps(maskVolatileMarkdown(content), path.dirname(abs))
        .map(dep => projectRelativeDependency(dep, sourceRoot))
        .filter(Boolean))
      : new Set()
    for (const dep of allDeps) {
      if (state.nonvolatile && nonvolatileDeps.has(dep)) mark(dep, 'nonvolatile')
      if (state.volatile || !nonvolatileDeps.has(dep)) mark(dep, 'volatile')
    }
  }

  const projection = []
  for (const [rel, state] of states) {
    if (!state.nonvolatile) continue
    const abs = path.join(sourceRoot, rel)
    if (!await fileExists(abs)) {
      projection.push([rel, 'missing'])
    } else if (MARKDOWN_RE.test(rel)) {
      projection.push([rel, `markdown:${maskVolatileMarkdown(await readFile(abs, 'utf8'))}`])
    } else {
      projection.push([rel, `file:${await hashFile(abs)}`])
    }
  }
  projection.sort(([a], [b]) => a.localeCompare(b))
  return projection
}
