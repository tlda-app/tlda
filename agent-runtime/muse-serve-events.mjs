// MSP view notifications -> muse parser records.
//
// The daemon's ingest path is JSONL lines through `parseMuseRecord` (a closure
// holding the pending tool-call map). MSP moves the transport — `muse serve`
// stdio instead of durable session files — but the event SHAPE the parser
// consumes is ours to choose. So the thin adapter maps each MSP view
// notification to the muse *parser record* shape it already understands, and
// feeds those records to the SAME parser instance through the SAME
// `extractActivityEvents` path. No second parser, no parallel mapping.
//
// Mapping (recorded from the live probes):
// - item/completed agentMessage {text} -> runtime.session run
//   assistant_message_committed {text} (the parser's assistant-text shape).
// - item/completed toolCall {tool, callId, args(JSON string), status,
//   visibleOutput, failureReason} -> tool_batch.effect.terminal with
//   {tool_name, call_id, outcome} + a synthetic
//   assistant_tool_calls_committed carrying {name, call_id, args} so the
//   parser's pendingCalls map resolves the name/input (MSP items carry the
//   name inline; the parser's map is keyed by call id — the synthetic commit
//   bridges the two without touching the parser).
// - turn/completed {terminal} -> dropped (admission/outcome bookkeeping lives
//   with the sender; ingest cares about content, not terminals).
// - approval/*, userInput/*, session/* usage notifications -> dropped (the
//   permission and usage surfaces consume those directly, not activity).

// MSP items are REVISIONS of one row, not one row per event: item/started
// announces the row, item/updated revises it (revision N), item/completed
// closes it. Only `item/completed` maps — earlier revisions would emit the
// same tool call N times. Measured: write_file completed at revision 3 after
// two inProgress revisions.
//
// Field table from the live probe (/tmp/muse-probe-events.jsonl):
// - agentMessage {text} / userMessage {text} (echo of our own turn input)
// - toolCall {tool, callId, args(JSON string), status, visibleOutput,
//   failureReason, patchSummary?, patchRef?}
// - reminderChild, subagent, workflow — no text the parser consumes; dropped.
export function mspViewNotificationToParserRecords(msg, { now = Date.now } = {}) {
  const method = msg?.method
  const params = msg?.params || {}
  if (method !== 'item/completed') return []
  const item = params.item || {}
  const recordedAt = Date.parse(item.recordedAt || '') || now() * 1000
  const out = []
  if (item.kind === 'agentMessage' && item.text) {
    out.push({
      id: `msp:${item.itemId || 'text'}`,
      recorded_at: Math.floor(recordedAt * 1000),
      payload_type: 'runtime.session',
      payload: { kind: 'run', event: { kind: 'assistant_message_committed', text: item.text } },
    })
  } else if (item.kind === 'toolCall') {
    const callId = item.callId || item.itemId
    if (!callId) return out
    if (item.tool) {
      out.push({
        id: `msp:commit:${callId}`,
        recorded_at: Math.floor(recordedAt * 1000),
        payload_type: 'runtime.session',
        payload: {
          kind: 'run',
          event: {
            kind: 'assistant_tool_calls_committed',
            tool_calls: [{ call_id: callId, name: item.tool, args: item.args ?? '{}' }],
          },
        },
      })
    }
    const failed = item.status === 'failed' || item.status === 'error' || item.failureReason != null
    out.push({
      id: `msp:terminal:${callId}`,
      recorded_at: Math.floor(recordedAt * 1000),
      payload_type: 'tool_batch.effect.terminal',
      payload: {
        record: {
          call_id: callId,
          tool_name: item.tool || null,
          outcome: { kind: failed ? 'failed' : 'completed' },
        },
      },
    })
    // The visible text travels beside the terminal, not inside it: the
    // durable effect shape holds no result text, so the parser carries MSP
    // text on a synthetic run event the durable path never emits.
    if (item.visibleOutput != null) {
      out.push({
        id: `msp:result:${callId}`,
        recorded_at: Math.floor(recordedAt * 1000),
        payload_type: 'runtime.session',
        payload: {
          kind: 'run',
          event: { kind: 'msp_tool_result_inline', tool_call_id: callId, text: item.visibleOutput, is_error: failed },
        },
      })
    }
  }
  return out
}
