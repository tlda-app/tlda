// Muse session activity source — map durable session records onto the same
// internal event shape consumed by the shared JSONL activity extractor.

import { editOperation, textChange } from './edit-operation.mjs'
import { extractIdentityFromText } from './daemon-jsonl-hot-path.mjs'

const NATIVE_NAME_MAP = {
  bash: 'Bash',
  bash_input: 'BashOutput',
  edit_file: 'Edit',
  read_file: 'Read',
  search: 'Grep',
  write_file: 'Write',
}

function timestamp(recordedAt) {
  const micros = Number(recordedAt)
  if (!Number.isFinite(micros)) return undefined
  return new Date(Math.floor(micros / 1000)).toISOString()
}

function parseArgs(value) {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return { _raw: String(value) }
  }
}

function normalizeInput(name, input, id) {
  if (!input || typeof input !== 'object') return {}
  if (name === 'bash' && input.command != null) return { command: input.command }
  if (name === 'bash_input') {
    return {
      session: input.session_id ?? input.sessionId ?? 'unknown',
      action: input.terminate
        ? 'stop'
        : (input.input == null || input.input === '' ? 'wait for output' : `send ${JSON.stringify(input.input)}`),
    }
  }
  if (name === 'edit_file' || name === 'write_file') {
    const filePath = input.path ?? input.file_path
    if (filePath == null) return input
    const before = name === 'edit_file' ? (input.find || '') : ''
    const after = name === 'edit_file' ? (input.replace || '') : (input.content || '')
    return {
      ...input,
      file_path: filePath,
      edit_operation: editOperation(name, id, [filePath], [textChange(filePath, before, after)]),
    }
  }
  return input
}

export function createMuseRecordParser() {
  const pendingCalls = new Map()

  return function parseMuseRecord(record) {
    const ts = timestamp(record?.recorded_at)
    const payloadType = record?.payload_type
    const payload = record?.payload || {}

    if (payloadType === 'runtime.user_intent.accepted') {
      const text = (payload.refill_blocks || [])
        .filter(block => block?.kind === 'text')
        .map(block => block.text || '')
        .join('')
      return text ? { type: 'user', timestamp: ts, blocks: [{ type: 'text', text }] } : null
    }

    if (payloadType === 'runtime.session' && payload.kind === 'run') {
      const event = payload.event || {}
      if (event.kind === 'assistant_tool_calls_committed') {
        for (const call of event.tool_calls || []) {
          if (!call?.call_id) continue
          pendingCalls.set(call.call_id, { name: call.name, input: parseArgs(call.args) })
        }
        return null
      }
      if (event.kind === 'assistant_message_committed' && event.text) {
        return { type: 'assistant', timestamp: ts, blocks: [{ type: 'text', text: event.text }] }
      }
      if (event.kind === 'tool_result_batch_committed') {
        // Result text is what result-built cards (screenshots, diffs) and
        // pretty-print bodies are made of; the muse parser used to drop it,
        // so those cards could never fire for muse. Emit one tool_result
        // block per id-bearing result — the extractor's noise and pretty
        // gates decide what Skip sees, and id-less results would be dropped
        // downstream anyway. Observed across 836 results in the wild:
        // {text, tool_call_id, tool_call_index} with no image parts;
        // revisit if image-bearing results appear.
        const blocks = []
        for (const result of event.results || []) {
          if (!result?.tool_call_id) continue
          blocks.push({ type: 'tool_result', id: result.tool_call_id, text: result.text ?? '', is_error: false })
        }
        return blocks.length ? { type: 'user', timestamp: ts, blocks } : null
      }
      return null
    }

    if (payloadType !== 'tool_batch.effect.started' && payloadType !== 'tool_batch.effect.terminal') return null
    const effect = payload.record || {}
    const callId = effect.call_id || effect.effect_id || record.id
    const pending = pendingCalls.get(callId) || {}
    if (payloadType === 'tool_batch.effect.terminal' && !effect.tool_name && !pending.name) return null
    const name = effect.tool_name || pending.name || 'muse_tool'
    const input = normalizeInput(name, pending.input || {}, callId)
    const terminal = payloadType === 'tool_batch.effect.terminal'
    if (terminal) pendingCalls.delete(callId)
    const status = terminal
      ? (effect.outcome?.kind === 'failed' ? 'error' : 'completed')
      : 'started'
    return {
      type: 'assistant',
      timestamp: ts,
      blocks: [{
        type: 'tool_use',
        name: NATIVE_NAME_MAP[name] || name,
        input,
        id: callId,
        status,
        correlationId: callId,
      }],
    }
  }
}

export function museLoginMarkerFromRecord(record) {
  const event = record?.payload_type === 'runtime.session' ? record?.payload?.event : null
  if (event?.kind !== 'tool_result_batch_committed') return null
  for (const result of event.results || []) {
    const identity = extractIdentityFromText(result?.text)
    if (identity?.marker?.fleet_id && identity.marker.harness_kind === 'muse') return identity.marker
  }
  return null
}

export const parseMuseRecord = createMuseRecordParser()

export function parseMuseLine(line) {
  let record
  try { record = JSON.parse(line) } catch { return null }
  return parseMuseRecord(record)
}
