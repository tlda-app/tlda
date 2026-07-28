// Select and filter Pandoc-flavored Markdown structure while returning Markdown.
//
// This is intentionally Markdown-native. HTML may appear in source markdown, but
// it is not the tree we query: selectors address headings, sections, paragraphs,
// and Pandoc fenced divs with their Pandoc attributes.

const FENCE_RE = /^\s*(```|~~~)/
const HEADING_RE = /^(#{1,6})\s+/
const DIV_OPEN_RE = /^\s*:::\s*(\{[^}]*\})?\s*$/
const DIV_CLOSE_RE = /^\s*:::\s*$/

export function parsePandocAttrs(text) {
  const attrMatch = String(text ?? '').match(/\{([^}]*)\}\s*$/)
  if (!attrMatch) return { id: null, classes: [], attrs: {}, raw: '' }
  const raw = attrMatch[0]
  const attrs = {}
  const classes = []
  let id = null
  const tokens = attrMatch[1].trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  for (const token of tokens) {
    if (token.startsWith('#')) id = token.slice(1)
    else if (token.startsWith('.')) classes.push(token.slice(1))
    else {
      const m = token.match(/^([^=]+)=(.*)$/)
      if (m) attrs[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return { id, classes, attrs, raw }
}

// Compute a heading's identifier from its text, following Pandoc's
// auto_identifier algorithm with one deliberate deviation: runs of removed
// punctuation collapse to a single hyphen (GitHub style: "Rate & bias" →
// "rate-bias", not Pandoc-strict "rate--bias").
export function headingId(headingText) {
  const explicit = parsePandocAttrs(headingText).id
  if (explicit) return explicit
  let s = String(headingText ?? '')
    .replace(/\s*\{[^}]*\}\s*$/, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_.\-]/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^\p{L}]+/u, '')
  return s || 'section'
}

function headingText(line) {
  return line.replace(HEADING_RE, '').replace(/\s*\{[^}]*\}\s*$/, '').trim()
}

function lineType(line) {
  if (HEADING_RE.test(line)) return 'heading'
  if (DIV_OPEN_RE.test(line) && !DIV_CLOSE_RE.test(line)) return 'div'
  if (/^\s*$/.test(line)) return 'blank'
  if (/^\s*</.test(line)) return 'html'
  return 'p'
}

function addChild(parent, child) {
  parent.children.push(child)
  child.parent = parent
}

export function parseMarkdownDocument(content) {
  const lines = String(content ?? '').split('\n')
  const root = {
    type: 'root',
    tag: 'root',
    id: null,
    classes: [],
    attrs: {},
    start: 0,
    end: lines.length,
    children: [],
    parent: null,
    lines,
  }
  const seen = new Map()
  const sectionStack = [root]
  const divStack = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const levelMatch = line.match(HEADING_RE)
    if (levelMatch) {
      const level = levelMatch[1].length
      while (divStack.length) divStack.pop().end = i
      while (sectionStack.length > 1 && sectionStack[sectionStack.length - 1].level >= level) {
        sectionStack.pop().end = i
      }
      const rawText = line.replace(HEADING_RE, '')
      const parsedAttrs = parsePandocAttrs(rawText)
      let id = parsedAttrs.id || headingId(rawText)
      const n = seen.get(id) || 0
      seen.set(id, n + 1)
      if (n > 0) id = `${id}-${n}`
      const node = {
        type: 'section',
        tag: `h${level}`,
        level,
        id,
        classes: parsedAttrs.classes,
        attrs: parsedAttrs.attrs,
        heading: headingText(line),
        start: i,
        end: lines.length,
        children: [],
        parent: null,
        lines,
      }
      addChild(sectionStack[sectionStack.length - 1], node)
      sectionStack.push(node)
      continue
    }

    const open = line.match(DIV_OPEN_RE)
    if (open && !DIV_CLOSE_RE.test(line)) {
      const parsedAttrs = parsePandocAttrs(open[1] || '')
      const node = {
        type: 'div',
        tag: 'div',
        id: parsedAttrs.id,
        classes: parsedAttrs.classes,
        attrs: parsedAttrs.attrs,
        start: i,
        end: lines.length,
        children: [],
        parent: null,
        lines,
      }
      const parent = divStack[divStack.length - 1] || sectionStack[sectionStack.length - 1]
      addChild(parent, node)
      divStack.push(node)
      continue
    }
    if (DIV_CLOSE_RE.test(line) && divStack.length) {
      divStack.pop().end = i + 1
      continue
    }

    const type = lineType(line)
    if (type === 'blank') continue
    const node = {
      type,
      tag: type,
      id: null,
      classes: [],
      attrs: {},
      start: i,
      end: i + 1,
      children: [],
      parent: null,
      lines,
    }
    const parent = divStack[divStack.length - 1] || sectionStack[sectionStack.length - 1]
    addChild(parent, node)
  }

  while (divStack.length) divStack.pop().end = lines.length
  while (sectionStack.length > 1) sectionStack.pop().end = lines.length
  return root
}

export function listMarkdownSectionIds(content) {
  return flatten(parseMarkdownDocument(content)).filter(n => n.type === 'section').map(n => n.id)
}

function flatten(node) {
  const out = []
  for (const child of node.children || []) {
    out.push(child, ...flatten(child))
  }
  return out
}

function splitSelectorList(selector) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of selector) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function parseSelector(selector) {
  const parts = []
  let buf = ''
  let depth = 0
  let combinator = null
  const flush = () => {
    const token = buf.trim()
    if (!token) return
    parts.push({ combinator, simple: token })
    combinator = ' '
    buf = ''
  }
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && ch === '>') {
      flush()
      combinator = '>'
      continue
    }
    if (depth === 0 && /\s/.test(ch)) {
      flush()
      continue
    }
    buf += ch
  }
  flush()
  if (depth !== 0 || parts.length === 0) throw new Error('invalid selector syntax')
  parts[0].combinator = null
  return parts
}

function matchSimple(node, simple) {
  const isMatch = simple.match(/^:is\((.*)\)$/)
  if (isMatch) return splitSelectorList(isMatch[1]).some(part => matchSelector(node, part))
  let rest = simple
  const tag = rest.match(/^[a-zA-Z][\w-]*/)
  if (tag) {
    if (node.tag !== tag[0] && node.type !== tag[0]) return false
    rest = rest.slice(tag[0].length)
  }
  for (const id of rest.matchAll(/#([\w:-]+)/g)) {
    if (node.id !== id[1]) return false
  }
  for (const cls of rest.matchAll(/\.([\w:-]+)/g)) {
    if (!node.classes.includes(cls[1])) return false
  }
  for (const attr of rest.matchAll(/\[([\w:-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g)) {
    const value = node.attrs[attr[1]]
    if (value == null) return false
    const want = attr[2] ?? attr[3] ?? attr[4]
    if (want != null && String(value) !== String(want).trim()) return false
  }
  const leftover = rest.replace(/:is\([^)]*\)|#[\w:-]+|\.[\w:-]+|\[[^\]]+\]/g, '').trim()
  if (leftover) throw new Error(`unsupported selector fragment "${leftover}"`)
  return true
}

function matchSelector(node, selector) {
  const chain = parseSelector(selector)
  function matchAt(current, idx) {
    if (!current || !matchSimple(current, chain[idx].simple)) return false
    if (idx === 0) return true
    const combinator = chain[idx].combinator
    if (combinator === '>') return matchAt(current.parent, idx - 1)
    for (let p = current.parent; p; p = p.parent) {
      if (matchAt(p, idx - 1)) return true
    }
    return false
  }
  return matchAt(node, chain.length - 1)
}

function matchesAny(node, selector) {
  return splitSelectorList(selector).some(part => matchSelector(node, part))
}

function nodeMarkdown(node) {
  return node.lines.slice(node.start, node.end).join('\n').replace(/\s+$/, '')
}

export function selectMarkdown(content, selector) {
  const want = String(selector ?? '').trim()
  if (!want) return { error: 'The `file` form needs a non-empty CSS `selector`.' }
  let matches
  try {
    matches = flatten(parseMarkdownDocument(content)).filter(node => matchesAny(node, want))
  } catch (error) {
    return { error: `Invalid CSS selector "${want}": ${error.message}` }
  }
  if (matches.length === 0) return { error: `No markdown elements match CSS selector "${want}".` }
  return { body: matches.map(nodeMarkdown).join('\n\n').trim() }
}

export function filterMarkdown(content, { drop, keep } = {}) {
  const root = parseMarkdownDocument(content)
  const removed = []
  let blocked = []
  for (const node of flatten(root)) {
    if (blocked.some(parent => node.start >= parent.start && node.end <= parent.end)) continue
    const dropMatch = drop ? matchesAny(node, drop) : false
    const keepMatch = keep ? matchesAny(node, keep) : true
    if (dropMatch || !keepMatch) {
      removed.push(node)
      blocked.push(node)
    }
  }
  const lines = root.lines.slice()
  for (const node of removed.sort((a, b) => b.start - a.start)) {
    lines.splice(node.start, node.end - node.start)
  }
  return { body: lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') }
}

export function filterMarkdownForTags(content, activeTags, { knownTags = ['app', 'math', 'ops', 'claude', 'codex', 'goose'] } = {}) {
  const active = new Set([].concat(activeTags || []).map(tag => String(tag).replace(/^\./, '')).filter(Boolean))
  const excluded = knownTags.filter(tag => !active.has(tag))
  if (excluded.length === 0) return { body: String(content ?? '').replace(/\s+$/, '') }
  return filterMarkdown(content, { drop: `:is(${excluded.map(tag => `.${tag}`).join(', ')})` })
}

export function filterMarkdownForLane(content, lane, options = {}) {
  return filterMarkdownForTags(content, [lane], options)
}
