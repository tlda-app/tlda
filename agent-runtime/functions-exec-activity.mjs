// Decode the JavaScript transport envelope used by Codex's `functions.exec`
// tool. The source rollout remains untouched; this module only projects real
// inner tools into the canonical activity shape consumed by the daemon.

const MCP_PREFIX = 'mcp__'

function skipQuoted(source, start) {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue }
    if (source[i] === quote) return i + 1
    i += 1
  }
  return source.length
}

function skipComment(source, start) {
  if (source[start + 1] === '/') {
    const end = source.indexOf('\n', start + 2)
    return end < 0 ? source.length : end + 1
  }
  if (source[start + 1] === '*') {
    const end = source.indexOf('*/', start + 2)
    return end < 0 ? source.length : end + 2
  }
  return start
}

function findClosingParen(source, open) {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(source, i) - 1; continue }
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) { i = skipComment(source, i) - 1; continue }
    if (ch === '(') depth += 1
    if (ch === ')' && --depth === 0) return i
  }
  return -1
}

function firstArgument(source) {
  let depth = 0
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(source, i) - 1; continue }
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) { i = skipComment(source, i) - 1; continue }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (ch === ',' && depth === 0) return source.slice(0, i).trim()
  }
  return source.trim()
}

// This intentionally accepts only data literals. It never evaluates rollout
// JavaScript. Unresolved variables/expressions are retained as `_raw` input.
function parseStaticLiteral(source) {
  let i = 0
  const ws = () => { while (/\s/.test(source[i] || '')) i += 1 }

  function string() {
    const quote = source[i++]
    let out = ''
    while (i < source.length) {
      const ch = source[i++]
      if (ch === quote) return out
      if (ch !== '\\') { out += ch; continue }
      const esc = source[i++]
      const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }
      if (esc in simple) out += simple[esc]
      else if (esc === 'u') {
        const hex = source.slice(i, i + 4)
        if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('invalid unicode escape')
        out += String.fromCharCode(Number.parseInt(hex, 16)); i += 4
      } else if (esc === 'x') {
        const hex = source.slice(i, i + 2)
        if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error('invalid hex escape')
        out += String.fromCharCode(Number.parseInt(hex, 16)); i += 2
      } else out += esc
    }
    throw new Error('unterminated string')
  }

  function identifier() {
    const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))
    if (!match) throw new Error('expected identifier')
    i += match[0].length
    return match[0]
  }

  function value() {
    ws()
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') {
      if (ch === '`' && source.slice(i).match(/^`(?:[^`\\]|\\.)*\$\{/)) throw new Error('dynamic template')
      return string()
    }
    if (ch === '{') {
      i += 1
      const out = {}
      ws()
      while (source[i] !== '}') {
        if (source.slice(i, i + 3) === '...') throw new Error('spread')
        const key = source[i] === '"' || source[i] === "'" ? string() : identifier()
        ws()
        if (source[i++] !== ':') throw new Error('expected colon')
        out[key] = value()
        ws()
        if (source[i] === ',') { i += 1; ws(); continue }
        if (source[i] !== '}') throw new Error('expected object end')
      }
      i += 1
      return out
    }
    if (ch === '[') {
      i += 1
      const out = []
      ws()
      while (source[i] !== ']') {
        out.push(value()); ws()
        if (source[i] === ',') { i += 1; ws(); continue }
        if (source[i] !== ']') throw new Error('expected array end')
      }
      i += 1
      return out
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(source.slice(i))
    if (number) { i += number[0].length; return Number(number[0]) }
    const word = identifier()
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    if (word === 'undefined') return undefined
    throw new Error('dynamic expression')
  }

  try {
    const parsed = value()
    ws()
    if (i !== source.length) return { _raw: source }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _raw: source, value: parsed }
  } catch {
    return source ? { _raw: source } : {}
  }
}

export function extractFunctionsExecCalls(source) {
  if (typeof source !== 'string' || !source.includes('tools.')) return []
  const calls = []
  for (let i = 0; i < source.length;) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(source, i); continue }
    if (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) { i = skipComment(source, i); continue }
    if (!source.startsWith('tools.', i) || /[\w$]/.test(source[i - 1] || '')) { i += 1; continue }
    const nameMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(i + 6))
    if (!nameMatch) { i += 6; continue }
    let open = i + 6 + nameMatch[0].length
    while (/\s/.test(source[open] || '')) open += 1
    if (source[open] !== '(') { i = open; continue }
    const close = findClosingParen(source, open)
    if (close < 0) return []
    const argSource = firstArgument(source.slice(open + 1, close))
    calls.push({ name: nameMatch[0], input: parseStaticLiteral(argSource), sourceStart: i })
    i = close + 1
  }
  return calls
}

export function isMcpToolName(name) {
  return typeof name === 'string' && name.startsWith(MCP_PREFIX)
}

export function mcpEndEvent(payload, timestamp) {
  const invocation = payload?.invocation
  if (!invocation?.server || !invocation?.tool) return null
  const name = `mcp__${invocation.server}__${invocation.tool}`
  const result = payload.result || {}
  const failed = Object.prototype.hasOwnProperty.call(result, 'Err')
  const body = failed ? result.Err : result.Ok
  const content = body?.content
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.map(item => item?.text || '').join('')
    : (typeof body === 'string' ? body : '')
  const id = payload.call_id
  return {
    type: 'assistant',
    timestamp,
    blocks: [
      {
        type: 'tool_use',
        name,
        input: invocation.arguments || {},
        id,
        status: failed || body?.isError === true ? 'error' : 'completed',
        duration: payload.duration || null,
        correlationId: id,
      },
      { type: 'tool_result', id, text, is_error: failed || body?.isError === true },
    ],
  }
}
