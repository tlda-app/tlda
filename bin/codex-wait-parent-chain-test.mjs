/**
 * A poll never becomes the thing being waited on.
 *
 * A broken card said `waitingOn: BashOutput`, which names the poll rather than
 * the command.
 *
 * A backgrounded command is reached through a chain. The shell yields a cell,
 * a poll waits on it, and the poll's OWN result yields a cell again. Each link
 * registers a parent for the next, so if a poll is allowed to be a parent the
 * original command drops out and the reader is told the agent is waiting on the
 * waiting. `pendingOperationLabel` makes it worse by falling back to the bare
 * tool name when a call has no subject of its own, which a poll never does.
 *
 * The `write_stdin` shape is the one that shipped broken: it is keyed by shell
 * session rather than cell, so it had no output handle, so the guard that keeps
 * a cell-keyed poll from overwriting its own parent did not cover it.
 */

import assert from 'node:assert/strict'
import { parseCodexRecord } from '../agent-runtime/codex-activity.mjs'
import { createActivityExtractor } from '../agent-runtime/jsonl-event-extract.mjs'

const ts = '2026-08-25T04:00:00.000Z'
const COMMAND = 'npm run build'

function exec(input, callId) {
  return { timestamp: ts, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input, call_id: callId } }
}

function nativeCall(name, args, callId) {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'function_call', name, arguments: JSON.stringify(args), call_id: callId },
  }
}

function output(callId, text) {
  return {
    timestamp: ts,
    type: 'response_item',
    payload: { type: 'custom_tool_call_output', call_id: callId, output: text },
  }
}

const YIELD = cell => `Script running with cell ID ${cell}\nWall time 30.0 seconds\nOutput:\n`

{
  // The observed shape: a command backgrounded in a shell session, then
  // polled by write_stdin (session-keyed), whose result yields a cell that a
  // wait then polls. The wait must name the command, not the poll.
  const extractor = createActivityExtractor()

  extractor.extractActivityEvents([parseCodexRecord(exec(`
    const r = await tools.exec_command({cmd:${JSON.stringify(COMMAND)},workdir:"/tmp",yield_time_ms:10000});
    text(r.output);
  `, 'call_exec'))])
  extractor.extractActivityEvents([parseCodexRecord(output('call_exec', YIELD(41)))])

  const firstWait = extractor.extractActivityEvents([
    parseCodexRecord(nativeCall('wait', { cell_id: '41', yield_time_ms: 30000 }, 'call_wait_1')),
  ])[0]
  assert.equal(firstWait.input.waitingOn, `Bash: ${COMMAND}`)

  // The poll's own result yields a cell. The next poll must still be told about
  // the command — this is the link that used to drop it.
  extractor.extractActivityEvents([parseCodexRecord(output('call_wait_1', YIELD(41)))])
  const secondWait = extractor.extractActivityEvents([
    parseCodexRecord(nativeCall('wait', { cell_id: '41', yield_time_ms: 30000 }, 'call_wait_2')),
  ])[0]
  assert.equal(secondWait.input.waitingOn, `Bash: ${COMMAND}`)
  assert.doesNotMatch(String(secondWait.input.waitingOn), /CodeOutput|BashOutput/)
}

{
  // The session-keyed poll, which is the one that shipped without a handle and
  // therefore registered ITSELF as the parent of the cell it was polling.
  const extractor = createActivityExtractor()

  extractor.extractActivityEvents([parseCodexRecord(exec(`
    const r = await tools.exec_command({cmd:${JSON.stringify(COMMAND)},workdir:"/tmp",yield_time_ms:10000});
    text(r.output);
  `, 'call_exec'))])
  extractor.extractActivityEvents([parseCodexRecord(output('call_exec', YIELD(41)))])

  const drain = extractor.extractActivityEvents([
    parseCodexRecord(nativeCall('write_stdin', { session_id: 67466, chars: '', yield_time_ms: 30000 }, 'call_drain')),
  ])[0]
  assert.equal(drain.tool, 'BashOutput')
  assert.equal(drain.input.action, 'wait for output')
  // A session poll is a poll: it carries a handle, so it is recognisable as one
  // run rather than N unrelated calls.
  assert.equal(drain.input._semanticOutputHandle, 'session:67466')

  extractor.extractActivityEvents([parseCodexRecord(output('call_drain', YIELD(41)))])
  const afterDrain = extractor.extractActivityEvents([
    parseCodexRecord(nativeCall('wait', { cell_id: '41', yield_time_ms: 30000 }, 'call_wait_after')),
  ])[0]
  assert.equal(
    afterDrain.input.waitingOn,
    `Bash: ${COMMAND}`,
    'a BashOutput poll must not become the thing being waited on',
  )
}

console.log('codex-wait-parent-chain-test: ok')
