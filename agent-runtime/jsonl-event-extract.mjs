import fs from 'fs'
import { truncatePrettyResult } from '../shared/activity-pretty-result.mjs'
import { ACTIVITY_NOISE, isPrettyPrintTool } from '../shared/activity-tool-classification.mjs'

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
      if (c.type === 'tool_use') return { type: 'tool_use', name: c.name, input: c.input, id: c.id }
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
          const input = block.input || {}
          const arg = input.file_path || input.path ||
            input.command || input.cat || input.pattern || input.message ||
            input.query || input.description || input.reason ||
            input.agent || input.doc || input.ref || input.text || input._raw || ''
          const evt = { tool: humanName, arg, ts: ev.timestamp, id: block.id }
          if (Object.keys(input).length > 0) evt.input = input
          // Attach result for pretty-printed tools
          if (isPrettyPrintTool(name) && block.id) {
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
