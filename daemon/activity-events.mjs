import fs from 'fs'
import { truncatePrettyResult } from '../shared/activity-pretty-result.mjs'
import { ACTIVITY_NOISE, isPrettyPrintTool } from '../shared/activity-tool-classification.mjs'

const pendingPrettyPrint = new Map()

export function parseSessionLine(jsonStr) {
  let obj
  try { obj = JSON.parse(jsonStr) } catch { return null }
  return parseSessionRecord(obj)
}

export function parseSessionRecord(obj) {
  const turnType = obj.type
  if (turnType === 'progress' || turnType === 'file-history-snapshot') return null
  const msg = obj.message || {}
  const ev = { type: turnType, timestamp: obj.timestamp }

  if (turnType === 'assistant' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(block => {
      if (block.type === 'tool_use') return { type: 'tool_use', name: block.name, input: block.input, id: block.id }
      if (block.type === 'text') return { type: 'text', text: block.text }
      return { type: block.type }
    })
    if (msg.usage) {
      const usage = msg.usage
      ev.usage = {
        input: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        output: usage.output_tokens || 0,
      }
    }
  } else if (turnType === 'user' && msg.content) {
    const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
    ev.blocks = content.map(block => {
      if (block.type === 'tool_result') {
        const items = typeof block.content === 'string' ? [{ type: 'text', text: block.content }] :
          Array.isArray(block.content) ? block.content : []
        const text = items.map(item => item.text || '').join('')
        const imgItem = items.find(item => item.type === 'image')
        const imgData = imgItem?.source?.type === 'base64' ? imgItem.source.data : (imgItem?.data || null)
        const imgMime = imgItem?.source?.media_type || imgItem?.mimeType || 'image/png'
        return { type: 'tool_result', id: block.tool_use_id, text, is_error: block.is_error || false, imgData, imgMime }
      }
      if (block.type === 'text') return { type: 'text', text: block.text }
      return { type: block.type }
    })
  } else {
    return null
  }
  return ev
}

export function extractActivityEvents(events) {
  const result = []
  const toolResults = new Map()
  for (const ev of events) {
    if (!ev.blocks) continue
    for (const block of ev.blocks) {
      if (block.type !== 'tool_result' || !block.id) continue
      let text = block.text || ''
      if (block.imgData) {
        try {
          const imgPath = `/tmp/tlda-ss-${block.id.replace(/[^a-z0-9]/gi, '_')}.png`
          fs.writeFileSync(imgPath, Buffer.from(block.imgData, 'base64'))
          text = text ? `${text}\n\nimage:${imgPath}` : `image:${imgPath}`
        } catch {
          // Screenshot extraction is best-effort; keep the textual tool result.
        }
      }
      toolResults.set(block.id, text)
    }
  }

  for (const ev of events) {
    if (!ev.blocks) continue
    for (const block of ev.blocks) {
      if (ev.type === 'user' && block.type === 'text') continue
      if (block.type === 'tool_use') {
        const name = block.name || ''
        if (ACTIVITY_NOISE.has(name)) continue
        const humanName = name.replace(/^mcp__/, '').replace(/__/g, '/')
        const input = block.input || {}
        const arg = input.file_path || input.path ||
          input.command || input.cat || input.pattern || input.message ||
          input.query || input.description || input.reason ||
          input.agent || input.doc || input.ref || input.text || ''
        const evt = { tool: humanName, arg, ts: ev.timestamp, id: block.id }
        if (Object.keys(input).length > 0) evt.input = input
        if (isPrettyPrintTool(name) && block.id) {
          if (toolResults.has(block.id)) {
            evt.prettyResult = truncatePrettyResult(toolResults.get(block.id), name)
          } else {
            pendingPrettyPrint.set(block.id, { evt: { ...evt }, expiresAt: Date.now() + 30000 })
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

  for (const [id, resultText] of toolResults) {
    const pending = pendingPrettyPrint.get(id)
    if (!pending) continue
    pendingPrettyPrint.delete(id)
    result.push({ ...pending.evt, prettyResult: truncatePrettyResult(resultText, pending.evt.tool) })
  }

  const now = Date.now()
  for (const [id, entry] of pendingPrettyPrint) {
    if (now <= entry.expiresAt) continue
    pendingPrettyPrint.delete(id)
    result.push(entry.evt)
  }
  return result
}
