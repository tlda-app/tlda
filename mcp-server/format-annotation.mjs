// format-annotation.mjs — shared formatters for annotation types.
//
// Used by:
//   - read_annotations (mcp-server/index.mjs) — formats shapes for agents
//   - resolveChipTokens (mcp-server/fleet.mjs) — expands «type:label#id» tokens
//
// All formatters return plain text strings suitable for agent consumption.

import { normalizePrettyResult } from '../shared/activity-pretty-result.mjs'
import { displayZoneOptions } from '../shared/display-time.mjs'

/**
 * Format a highlight/highlighter shape.
 * @param {object} annotation - processed annotation object with fields:
 *   color, sortLine, page, lines, highlightedText, highlightText, id
 * @returns {string}
 */
export function formatHighlight(annotation) {
  const lineRef = annotation.sortLine ? `L${annotation.sortLine}` : (annotation.page ? `p${annotation.page}` : '')
  const hlText = annotation.highlightedText || annotation.highlightText || ''
  const fileRef = annotation.sourceFile ? ` ${annotation.sourceFile}` : (annotation.file ? ` ${annotation.file}` : '')
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
  const noteText = annotation.text || ''
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
  const msgText = event.text || ''
  const d = new Date(event.timestamp)
  const ts = d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...displayZoneOptions() })
  const iso = isNaN(d.getTime()) ? null : d.toISOString()
  // The party whose thread to open for surrounding history: the non-human side.
  const isHuman = (id) => !!id && id.startsWith('fleet:skip')
  const threadAgent = isHuman(event.from) ? event.to : event.from
  const body = `[msg] ${from} → ${to}, ${ts}\n> ${msgText.split('\n').join('\n> ')}`
  if (!iso || !threadAgent) return body
  return `${body}\n↳ reference to the conversation history at this point. To read the surrounding thread: thread({ agent: "${threadAgent}", until: "${iso}" })`
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
  const ts = new Date(firstTs).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...displayZoneOptions() })

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
        const result = normalizePrettyResult(m.prettyResult).slice(0, 300)
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
 *
 * @param {object} refData - ref attachment with fields:
 *   type, label, color, file, sourceLines, content
 *   sourceLines: [{line, content, file, highlighted, hlStart?, hlEnd?}]
 *   hlStart/hlEnd are character offsets within the line for precise column ranges.
 * @returns {string}
 */
export function formatAnnotationRef(refData) {
  if (!refData) return null
  const { type, label, color } = refData
  const sourceLines = Array.isArray(refData.sourceLines)
    ? refData.sourceLines.filter(sl => sl?.anchored !== false && Number.isFinite(Number(sl?.line)))
    : []
  const file = refData.file || sourceLines.find(sl => sl.file)?.file

  // Unresolved highlight — calibration failed, show SVG-extracted text
  if (refData.unresolved) {
    const content = refData.content || label || ''
    return `[${type || 'highlight'}] ${color || ''} ⚠ unresolved\n  ⟦${content}⟧`
  }

  // Build location string as "file:line:col–line:col" ranges.
  // Group contiguous highlighted lines into ranges; handle discontinuous highlights.
  let locationRef = ''
  if (file && sourceLines && sourceLines.length > 0) {
    const highlighted = sourceLines.filter(sl => sl.highlighted)
    if (highlighted.length > 0) {
      // Group into contiguous runs
      const runs = []
      let runStart = highlighted[0], runEnd = highlighted[0]
      for (let i = 1; i < highlighted.length; i++) {
        if (highlighted[i].line === runEnd.line + 1) {
          runEnd = highlighted[i]
        } else {
          runs.push([runStart, runEnd])
          runStart = highlighted[i]
          runEnd = highlighted[i]
        }
      }
      runs.push([runStart, runEnd])

      const rangeStrs = runs.map(([start, end]) => {
        const sc = start.hlStart != null ? `:${start.hlStart}` : ''
        const ec = end.hlEnd != null ? `:${end.hlEnd}` : ''
        if (start.line === end.line) return `${start.line}${sc}–${start.line}${ec}`
        return `${start.line}${sc}–${end.line}${ec}`
      })
      locationRef = ` ${file.split('/').pop()}:${rangeStrs.join(', ')}`
    } else if (file) {
      locationRef = ` ${file.split('/').pop()}`
    }
  } else if (file) {
    locationRef = ` ${file.split('/').pop()}`
  }

  let out = `[${type || 'annotation'}] ${color || ''}${locationRef}`.trimEnd()

  // Build passage: context lines with highlighted portions wrapped in ⟦⟧.
  if (sourceLines.length > 0) {
    const passageLines = sourceLines.map(sl => {
      if (!sl.highlighted) return sl.content
      if (sl.hlStart != null && sl.hlEnd != null && sl.hlEnd > sl.hlStart) {
        return sl.content.slice(0, sl.hlStart) + '⟦' + sl.content.slice(sl.hlStart, sl.hlEnd) + '⟧' + sl.content.slice(sl.hlEnd)
      }
      return '⟦' + sl.content + '⟧'
    })
    out += '\n  ' + passageLines.join('\n  ')
  } else {
    const content = refData.content || label || ''
    if (content) out += content.includes('⟦') ? `\n  ${content}` : `\n  ⟦${content}⟧`
  }

  return out
}
