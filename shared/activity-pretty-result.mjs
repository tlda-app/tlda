export function unwrapMcpTextEnvelope(text) {
  if (typeof text !== 'string') return text
  const stripped = stripCodexToolEnvelope(text)
  const trimmed = stripped.trim()
  if (!trimmed) return stripped
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed) && parsed.every(part => part && part.type === 'text' && typeof part.text === 'string')) {
      return parsed.map(part => part.text).join('\n')
    }
    if (parsed && parsed.type === 'text' && typeof parsed.text === 'string') return parsed.text
  } catch {
    return stripped
  }
  return stripped
}

export function stripCodexToolEnvelope(text) {
  if (typeof text !== 'string') return text
  const match = text.match(/^Wall time:[^\n]*\nOutput:\n?([\s\S]*)$/)
  return match ? match[1] : text
}

export function truncatePrettyResult(text, toolName) {
  const unwrapped = unwrapMcpTextEnvelope(String(text ?? ''))
  if (unwrapped.length <= 5000) return unwrapped
  const tool = (toolName || '').toLowerCase()
  if (tool.includes('get_thread') || tool.includes('thread')) {
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
