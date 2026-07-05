const OP_CHARS = new Set(['&', '|', '!', '(', ')'])
const PHASES = new Set(['bare', 'dawn', 'day', 'dusk', 'night', 'zombie'])

export function tokenizeFilterExpression(input) {
  const toks = []
  const str = String(input || '')
  let i = 0
  while (i < str.length) {
    const c = str[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === '<' && str[i + 1] === '>') { toks.push({ k: 'between', v: '<>' }); i += 2; continue }
    if (OP_CHARS.has(c)) { toks.push({ k: 'op', v: c }); i++; continue }
    let j = i
    while (j < str.length) {
      if (/\s/.test(str[j]) || OP_CHARS.has(str[j])) break
      if (str[j] === '<' && str[j + 1] === '>') break
      j++
    }
    toks.push({ k: 'lit', v: str.slice(i, j) })
    i = j
  }
  return toks
}

export function parseUnifiedFilter(input, { sort = 'agent' } = {}) {
  if (input == null) return null
  if (typeof input !== 'string') {
    throw new Error(`filter must be a string expression, got ${Array.isArray(input) ? 'array' : typeof input}`)
  }
  const toks = tokenizeFilterExpression(input)
  if (toks.length === 0) return null
  let p = 0
  const peek = () => toks[p]
  const eat = (v) => {
    const t = toks[p]
    if (!t || (v && t.v !== v)) {
      throw new Error(`filter parse error: expected ${v || 'token'} at position ${p} in "${input}"`)
    }
    p++
    return t
  }
  const atomStart = (t) => t && (t.k === 'lit' || (t.k === 'op' && t.v === '(') || (t.k === 'op' && t.v === '!'))

  function parseOr() {
    let node = parseAnd()
    while (peek()?.k === 'op' && peek().v === '|') {
      eat('|')
      node = { t: 'or', l: node, r: parseAnd() }
    }
    return node
  }

  function parseAnd() {
    let node = parseBetween()
    while (true) {
      if (peek()?.k === 'op' && peek().v === '&') {
        eat('&')
        node = { t: 'and', l: node, r: parseBetween() }
        continue
      }
      if (sort === 'message' && atomStart(peek())) {
        node = { t: 'and', l: node, r: parseBetween() }
        continue
      }
      return node
    }
  }

  function parseBetween() {
    let node = parseNot()
    while (peek()?.k === 'between') {
      if (sort !== 'message') throw new Error(`filter parse error: <> is only valid in message filters`)
      eat('<>')
      node = { t: 'between', l: node, r: parseNot() }
    }
    return node
  }

  function parseNot() {
    if (peek()?.k === 'op' && peek().v === '!') {
      eat('!')
      return { t: 'not', x: parseNot() }
    }
    return parseAtom()
  }

  function parseAtom() {
    const t = peek()
    if (!t) throw new Error(`filter parse error: unexpected end of "${input}"`)
    if (t.k === 'op' && t.v === '(') {
      eat('(')
      const e = parseOr()
      eat(')')
      return e
    }
    if (t.k !== 'lit') throw new Error(`filter parse error: unexpected "${t.v}" in "${input}"`)
    p++
    return parseLiteral(t.v)
  }

  function parseLiteral(value) {
    for (const key of ['from', 'to', 'involving', 'since', 'before', 'type']) {
      const prefix = `${key}:`
      if (value.startsWith(prefix)) {
        if (sort !== 'message' && (key === 'from' || key === 'to' || key === 'involving' || key === 'since' || key === 'before' || key === 'type')) {
          throw new Error(`filter parse error: ${key}: is only valid in message filters`)
        }
        const rest = value.slice(prefix.length)
        if (!rest) {
          if (key === 'since' || key === 'before' || key === 'type') throw new Error(`filter parse error: missing value after ${prefix}`)
          return { t: key, x: parseAtom() }
        }
        if (key === 'since' || key === 'before' || key === 'type') return { t: key, v: rest }
        return { t: key, x: parseAgentLiteral(rest) }
      }
    }
    return parseAgentLiteral(value)
  }

  const ast = parseOr()
  if (p !== toks.length) throw new Error(`filter parse error: trailing "${toks[p].v}" in "${input}"`)
  return ast
}

export function parseAgentLiteral(value) {
  if (value === 'me') return { t: 'me' }
  const selector = parseAgentSelector(value)
  return selector ? { t: 'lit', v: selector.fragment, selector } : { t: 'lit', v: value }
}

export function parseAgentSelector(raw) {
  let text = String(raw || '').trim()
  if (!text) return null
  const selector = {
    fragment: text,
    expansion: 'stack',
    match: 'auto',
  }
  const range = parseRangeSuffix(text)
  if (range) {
    text = range.fragment
    if (range.range) selector.range = range.range
    else selector.position = range.position
    selector.match = 'substring'
  }
  const phaseSuffix = text.match(/:([A-Za-z][A-Za-z0-9_-]*)$/)
  if (phaseSuffix && PHASES.has(phaseSuffix[1])) {
    selector.phase = phaseSuffix[1]
    text = text.slice(0, -phaseSuffix[0].length)
  }
  selector.fragment = text.trim()
  return selector.fragment === raw && selector.match === 'auto' && selector.phase == null ? null : selector
}

function parseRangeSuffix(text) {
  const single = text.match(/~(\d+)$/)
  if (single) return { fragment: text.slice(0, -single[0].length), position: parseInt(single[1], 10) }
  const tildeRange = text.match(/~(\d*)\.\.(\d*)$/)
  if (tildeRange) {
    if (!tildeRange[1] && !tildeRange[2]) return null
    return {
      fragment: text.slice(0, -tildeRange[0].length),
      range: {
        from: tildeRange[1] ? parseInt(tildeRange[1], 10) : null,
        to: tildeRange[2] ? parseInt(tildeRange[2], 10) : null,
      },
    }
  }
  const colonRange = text.match(/:(\d+)\.\.(\d*)$/)
  if (colonRange) {
    return {
      fragment: text.slice(0, -colonRange[0].length),
      range: { from: parseInt(colonRange[1], 10), to: colonRange[2] ? parseInt(colonRange[2], 10) : null },
    }
  }
  const topRange = text.match(/\.\.(\d+)$/)
  if (topRange) {
    return {
      fragment: text.slice(0, -topRange[0].length),
      range: { from: null, to: parseInt(topRange[1], 10) },
    }
  }
  return null
}

export function desugarMessageFilter(ast) {
  if (!ast) return null
  switch (ast.t) {
    case 'involving':
      return { t: 'or', l: { t: 'from', x: ast.x }, r: { t: 'to', x: ast.x } }
    case 'between':
      return {
        t: 'or',
        l: { t: 'and', l: { t: 'from', x: ast.l }, r: { t: 'to', x: ast.r } },
        r: { t: 'and', l: { t: 'from', x: ast.r }, r: { t: 'to', x: ast.l } },
      }
    case 'and': return { t: 'and', l: desugarMessageFilter(ast.l), r: desugarMessageFilter(ast.r) }
    case 'or': return { t: 'or', l: desugarMessageFilter(ast.l), r: desugarMessageFilter(ast.r) }
    case 'not': return { t: 'not', x: desugarMessageFilter(ast.x) }
    default: return ast
  }
}
