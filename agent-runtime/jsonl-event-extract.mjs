import fs from 'fs'
import { truncatePrettyResult } from '../shared/activity-pretty-result.mjs'
import { ACTIVITY_NOISE, isPrettyPrintTool } from '../shared/activity-tool-classification.mjs'
import { editOperation, textChange } from './edit-operation.mjs'

function normalizedToolInput(name, input, id) {
  const kind = String(name || '').toLowerCase()
  const file = input?.file_path || input?.path
  if (!['edit','write','multiedit'].includes(kind) || !file) return input
  const pairs = kind === 'multiedit'
    ? (input.edits || []).map(item => [item.old_string || '', item.new_string || ''])
    : [[input.old_string ?? input.before ?? '', input.new_string ?? input.after ?? input.content ?? '']]
  return { ...input, edit_operation: editOperation(kind, id, [file], pairs.map(pair => textChange(file, pair[0], pair[1]))) }
}

export function parseSessionLine(jsonStr) {
  let obj
  try { obj = JSON.parse(jsonStr) } catch { return null }
  return parseSessionRecord(obj)
}

export function parseSessionRecord(obj) {
  const t = obj.type
  if (t === 'progress' || t === 'file-history-snapshot') return null
  const msg = obj.message || {}
  const ev = { type: t, timestamp: obj.timestamp }

  if (t === 'assistant' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(c => {
      if (c.type === 'tool_use') return { type: 'tool_use', name: c.name, input: normalizedToolInput(c.name, c.input || {}, c.id), id: c.id }
      if (c.type === 'text') return { type: 'text', text: c.text }
      return { type: c.type }
    })
    if (msg.usage) {
      const u = msg.usage
      ev.usage = {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
      }
    }
  } else if (t === 'user' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(c => {
      if (c.type === 'tool_result') {
        const items = typeof c.content === 'string' ? [{ type: 'text', text: c.content }] :
          Array.isArray(c.content) ? c.content : []
        const text = items.map(x => x.text || '').join('')
        const imgItem = items.find(x => x.type === 'image')
        const imgData = imgItem?.source?.type === 'base64' ? imgItem.source.data : (imgItem?.data || null)
        const imgMime = imgItem?.source?.media_type || imgItem?.mimeType || 'image/png'
        return { type: 'tool_result', id: c.tool_use_id, text, is_error: c.is_error || false, imgData, imgMime }
      }
      if (c.type === 'text') return { type: 'text', text: c.text }
      return { type: c.type }
    })
  } else {
    return null
  }
  return ev
}

export function createActivityExtractor({ now = () => Date.now() } = {}) {
  // Pending pretty-print tool_uses waiting for their results. Keyed by
  // tool_use_id. Entries expire after 30s to avoid leaking memory on abandoned
  // tool calls.
  const pendingPrettyPrint = new Map()
  const pendingTools = new Map()
  const pendingOutputParents = new Map()

  function pendingOperationLabel(pendings) {
    const operations = pendings.filter(Boolean)
    if (operations.length > 1) {
      const tools = [...new Set(operations.map(p => p.tool).filter(Boolean))]
      return `Code: ${operations.length} operations${tools.length ? ` (${tools.join(', ')})` : ''}`
    }
    const pending = operations[0]
    if (!pending) return ''
    if (pending.tool === 'Code') return 'Code'
    const input = pending.input || {}
    const subject = input.command || input.description || pending.arg || ''
    const oneLine = String(subject).replace(/\s+/g, ' ').trim()
    const bounded = oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine
    return bounded ? `${pending.tool}: ${bounded}` : (pending.tool || '')
  }

  function extractActivityEvents(events) {
    const result = []
    // Collect tool_results keyed by tool_use_id so we can match them
    const toolResults = new Map()
    for (const ev of events) {
      if (!ev.blocks) continue
      for (const block of ev.blocks) {
        if (block.type === 'tool_result' && block.id) {
          let text = block.text || ''
          if (block.imgData) {
            try {
              const imgPath = `/tmp/tlda-ss-${block.id.replace(/[^a-z0-9]/gi, '_')}.png`
              fs.writeFileSync(imgPath, Buffer.from(block.imgData, 'base64'))
              text = text ? text + '\n\nimage:' + imgPath : 'image:' + imgPath
            } catch { /* disk write failed — fall back to text-only prettyResult */ }
          }
          toolResults.set(block.id, text)
        }
      }
    }
    for (const ev of events) {
      if (!ev.blocks) continue
      for (const block of ev.blocks) {
        // Skip text from user turns — terminal input is captured separately
        // as terminal-chat. tool_result blocks fall through fine.
        if (ev.type === 'user' && block.type === 'text') continue
        if (block.type === 'tool_use') {
          const name = block.name || ''
          if (ACTIVITY_NOISE.has(name)) continue
          const humanName = name.replace(/^mcp__/, '').replace(/__/g, '/')
          let input = block.input || {}
          const outputHandle = input.cell != null ? `cell:${input.cell}` : ''
          if (outputHandle && input.action === 'wait for output') {
            const waitingOn = pendingOutputParents.get(outputHandle)
            if (waitingOn) {
              input = {
                waitingOn,
                action: input.action,
                _semanticOutputHandle: outputHandle,
              }
            }
          }
          const arg = input.file_path || input.path ||
            input.command || input.cat || input.pattern || input.message ||
            input.query || input.description || input.reason ||
            input.agent || input.doc || input.ref || input.text || input._raw || ''
          const evt = { tool: humanName, arg, ts: ev.timestamp, id: block.id }
          evt.status = block.status || 'started'
          if (block.duration) evt.duration = block.duration
          if (block.correlationId) evt.correlationId = block.correlationId
          if (Object.keys(input).length > 0) evt.input = input
          if (block.id && evt.status !== 'completed' && evt.status !== 'error') {
            pendingTools.set(block.id, { tool: humanName, arg, input, ts: ev.timestamp })
          }
          // Unknown Codex-native tools use the same result-bearing fallback as
          // established pretty-print cards. The marker is internal adapter
          // metadata; the call's own arguments remain unchanged in the UI.
          if ((isPrettyPrintTool(name) || input._unknownCodexToolKind) && block.id) {
            if (toolResults.has(block.id)) {
              const raw = toolResults.get(block.id)
              evt.prettyResult = truncatePrettyResult(raw, name)
            } else {
              // Result not in this batch — stash and wait so the eventual card
              // has the same shape as a same-batch Claude pretty-result card.
              pendingPrettyPrint.set(block.id, { evt: { ...evt }, expiresAt: now() + 30000 })
              continue
            }
          }
          result.push(evt)
        } else if (block.type === 'text' && block.text?.trim().length > 0) {
          result.push({ tool: '_text', arg: block.text, ts: ev.timestamp })
        }
      }
      if (ev.usage) result.push({ tool: '_usage', ts: ev.timestamp, usage: ev.usage })
    }
    for (const [resultId] of toolResults) {
      const matchingIds = pendingTools.has(resultId)
        ? [resultId]
        : [...pendingTools.keys()].filter(id => id.startsWith(`${resultId}#`))
      const matchingPendings = matchingIds.map(id => pendingTools.get(id)).filter(Boolean)
      const resultText = toolResults.get(resultId) || ''
      const yieldedCell = resultText.match(/Script running with cell ID\s+([^\s]+)/)?.[1]
      const yieldedLabel = pendingOperationLabel(matchingPendings)
      for (const id of matchingIds) {
        const pending = pendingTools.get(id)
        pendingTools.delete(id)
        if (yieldedCell) {
          if (!pending.input?._semanticOutputHandle && yieldedLabel) {
            pendingOutputParents.set(`cell:${yieldedCell}`, yieldedLabel)
          }
        } else if (pending.input?._semanticOutputHandle) {
          pendingOutputParents.delete(pending.input._semanticOutputHandle)
        } else if (pending.input?.cell != null) {
          pendingOutputParents.delete(`cell:${pending.input.cell}`)
        }
        result.push({
          tool: pending.tool,
          arg: pending.arg,
          input: pending.input,
          ts: events.at(-1)?.timestamp || pending.ts,
          id,
          status: 'completed',
          correlationId: id,
        })
      }
    }
    // Check if any tool_results in this batch match pending pretty-print requests
    for (const [id, resultText] of toolResults) {
      const pending = pendingPrettyPrint.get(id)
      if (pending) {
        pendingPrettyPrint.delete(id)
        const capped = truncatePrettyResult(resultText, pending.evt.tool)
        result.push({ ...pending.evt, prettyResult: capped })
      }
    }
    // Expire old pending entries
    const ts = now()
    for (const [id, entry] of pendingPrettyPrint) {
      if (ts > entry.expiresAt) {
        pendingPrettyPrint.delete(id)
        result.push(entry.evt)
      }
    }
    return result
  }

  return { extractActivityEvents, pendingCount: () => pendingPrettyPrint.size }
}

export const defaultActivityExtractor = createActivityExtractor()
