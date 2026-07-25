export function normalizePrettyResult(value) {
  if (value == null) return ''
  if (typeof value === 'string') {
    const stripped = stripCodexToolEnvelope(value)
    const trimmed = stripped.trim()
    if (!trimmed) return stripped
    try {
      const parsed = JSON.parse(trimmed)
      const normalized = normalizePrettyResultEnvelope(parsed)
      return normalized != null ? normalized : stripped
    } catch {
      return stripped
    }
  }
  const normalized = normalizePrettyResultEnvelope(value)
  return normalized != null ? normalized : ''
}

export function unwrapMcpTextEnvelope(value) {
  return normalizePrettyResult(value)
}

export function stripCodexToolEnvelope(text) {
  if (typeof text !== 'string') return text
  const match = text.match(/^Wall time:[^\n]*\nOutput:\n?([\s\S]*)$/)
  return match ? match[1] : text
}

function normalizePrettyResultEnvelope(value) {
  if (value == null) return ''
  if (typeof value === 'string') return normalizePrettyResult(value)
  if (Array.isArray(value)) {
    if (value.every(part => part && part.type === 'text' && typeof part.text === 'string')) {
      return value.map(part => normalizePrettyResult(part.text)).join('\n')
    }
    const parts = value.map(normalizePrettyResultEnvelope).filter(part => part != null && part !== '')
    return parts.length ? parts.join('\n') : null
  }
  if (typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') return normalizePrettyResult(value.text)
    for (const key of ['content', 'value', 'toolResult', 'text', 'output', 'result']) {
      if (value[key] != null) {
        const normalized = normalizePrettyResultEnvelope(value[key])
        if (normalized != null) return normalized
      }
    }
  }
  return null
}

export function compactPrettyResult(value, max = 600) {
  const text = normalizePrettyResult(value)
  return text.length > max ? `${text.slice(0, max)}... [truncated ${text.length - max} chars]` : text
}

export function indentPrettyResult(value, prefix = '  ') {
  return String(value).split('\n').map(line => `${prefix}${line}`).join('\n')
}

export function truncatePrettyResult(text, toolName) {
  const unwrapped = normalizePrettyResult(text)
  if (unwrapped.length <= 5000) return unwrapped
  const tool = (toolName || '').toLowerCase()
  if (tool.includes('thread')) {
    const sep = '\n\n---\n\n'
    const msgs = unwrapped.split(sep)
    if (msgs.length > 8) {
      const front = msgs.slice(0, 3)
      const tail = msgs.slice(-5)
      const hidden = msgs.length - 8
      return front.join(sep) + sep + `... ${hidden} messages ...` + sep + tail.join(sep)
    }
  }
  return unwrapped.slice(0, 5000) + '\n\n... (truncated)'
}
