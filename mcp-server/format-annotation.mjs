// format-annotation.mjs — shared formatters for annotation types.
//
// Used by:
//   - read_annotations (mcp-server/index.mjs) — formats shapes for agents
//   - resolveChipTokens (mcp-server/fleet.mjs) — expands «type:label#id» tokens
//
// All formatters return plain text strings suitable for agent consumption.

/**
 * Format a highlight/highlighter shape.
 * @param {object} annotation - processed annotation object with fields:
 *   color, sortLine, page, lines, highlightedText, highlightText, id
 * @returns {string}
 */
export function formatHighlight(annotation) {
  const lineRef = annotation.sortLine ? `L${annotation.sortLine}` : (annotation.page ? `p${annotation.page}` : '')
  const hlText = annotation.highlightedText || annotation.highlightText || ''
  const fileRef = annotation.file ? ` ${annotation.file}` : ''
  let out = `[highlight] ${annotation.color || 'yellow'} ${lineRef}${fileRef}`
  if (hlText) {
    if (hlText.includes('⟦')) {
      out += `\n  ${hlText}`
    } else {
      out += `\n  ⟦${hlText}⟧`
    }
  } else if (annotation.lines?.length > 0) {
    out += `\n  covers lines ${annotation.lines[0].line}–${annotation.lines[annotation.lines.length - 1].line}`
  }
  return out
}

/**
 * Format a math-note annotation.
 * @param {object} annotation - annotation object with fields:
 *   color, sortLine, page, text, id
 * @returns {string}
 */
export function formatNote(annotation) {
  const lineRef = annotation.sortLine ? `L${annotation.sortLine}` : (annotation.page ? `p${annotation.page}` : '')
  const fileRef = annotation.file ? ` ${annotation.file}` : ''
  let out = `[note] ${annotation.color || 'yellow'} ${lineRef}${fileRef}`
  const noteText = (annotation.text || '').substring(0, 200)
  if (noteText) out += `\n  "${noteText}"`
  return out
}

/**
 * Format a chat message event.
 * @param {object} event - event with fields: from, to, text, timestamp
 * @param {Array} agents - agent list for name resolution [{id, friendly_name, name}]
 * @returns {string}
 */
export function formatMessage(event, agents = []) {
  const nameOf = (id) => {
    if (!id) return '?'
    const a = agents.find(a => a.id === id)
    if (a) return a.friendly_name || a.name || id
    return id.replace('fleet:', '')
  }
  const from = nameOf(event.from)
  const to = nameOf(event.to)
  const msgText = (event.text || '').slice(0, 500)
  const ts = new Date(event.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `[msg] ${from} → ${to}, ${ts}\n> ${msgText.split('\n').join('\n> ')}`
}

/**
 * Format a list of activity events for an agent.
 * @param {Array} events - activity events with fields: from, timestamp, metadata, text
 * @param {Array} agents - agent list for name resolution
 * @returns {string}
 */
export function formatActivity(events, agents = []) {
  if (!events || events.length === 0) return ''
  const agentId = events[0]?.from || events[0]?.to || ''
  const nameOf = (id) => {
    if (!id) return '?'
    const a = agents.find(a => a.id === id)
    if (a) return a.friendly_name || a.name || id
    return id.replace('fleet:', '')
  }
  const agentName = nameOf(agentId)
  const firstTs = events[0]?.timestamp || new Date().toISOString()
  const ts = new Date(firstTs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  const toolLines = events
    .filter(e => {
      const tool = e.metadata?.tool || e.text || ''
      return tool && tool !== '_text' && !tool.includes('\n')
    })
    .map(e => {
      const m = e.metadata || {}
      const tool = m.tool || e.text || ''
      let line = `  ${tool}${m.arg ? ': ' + m.arg : ''}`
      if (m.prettyResult) {
        const result = m.prettyResult.slice(0, 300)
        line += `\n    ${result.split('\n').join('\n    ')}`
      }
      return line
    })
  const textBlocks = events
    .filter(e => (e.metadata?.tool === '_text' || (!e.metadata?.tool && e.text?.includes('\n'))) && e.text)
    .map(e => e.text.slice(0, 300))

  let out = `[activity] ${agentName} ${ts}`
  if (toolLines.length > 0) out += `\n${toolLines.join('\n')}`
  if (textBlocks.length > 0) out += `\n> ${textBlocks.join('\n> ')}`
  return out
}

/**
 * Format an annotation ref attachment (from message metadata.attachments).
 * Used to expand «annotation:label#shape:id» and «highlight:label#shape:id» chip tokens.
 * @param {object} refData - ref attachment with fields: type, label, color, file, lineno, content
 * @returns {string}
 */
export function formatAnnotationRef(refData) {
  if (!refData) return null
  const { type, label, color, file, lineno } = refData
  const lineRef = lineno ? `L${lineno}` : ''
  const fileRef = file ? ` ${file.split('/').pop()}` : ''
  let out = `[${type || 'annotation'}] ${color || ''} ${lineRef}${fileRef}`.trimEnd()
  const content = refData.content || label || ''
  if (content) {
    if (content.includes('⟦')) {
      out += `\n  ${content}`
    } else {
      out += `\n  ⟦${content}⟧`
    }
  }
  return out
}
