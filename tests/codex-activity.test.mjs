// Test parseCodexLine against real captured Codex rollouts.
// Run: node tests/codex-activity.test.mjs [path-to-rollout.jsonl ...]
// With no args, scans ~/.codex/sessions for rollout-*.jsonl.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseCodexLine, unwrapCodexToolOutput } from '../agent-runtime/codex-activity.mjs'
import { ACTIVITY_NOISE, humanToolName, isPrettyPrintTool } from '../shared/activity-tool-classification.mjs'

// --- faithful copy of the bits of extractActivityEvents we exercise ---
// (uses the shared fleet tool classification so parser tests can't drift from
// daemon/runtime activity filtering.)
const pendingPrettyPrint = new Map()
function extractCards(events) {
  const cards = []
  const toolResults = new Map()
  for (const ev of events) {
    if (!ev.blocks) continue
    for (const b of ev.blocks) {
      if (b.type === 'tool_result' && b.id) toolResults.set(b.id, b.text || '')
    }
  }
  for (const ev of events) {
    if (ev.usage) cards.push({ tool: '_usage', usage: ev.usage })
    if (!ev.blocks) continue
    for (const b of ev.blocks) {
      if (ev.type === 'user' && b.type === 'text') continue
      if (b.type === 'tool_use') {
        if (ACTIVITY_NOISE.has(b.name)) continue
        const humanName = humanToolName(b.name)
        const input = b.input || {}
        const arg = input.file_path || input.path || input.command || input.cat || input.pattern ||
          input.message || input.query || input.description || input.reason ||
          input.agent || input.doc || input.ref || input.text || ''
        const card = { tool: humanName, arg: String(arg).slice(0, 80) }
        if (isPrettyPrintTool(b.name) && b.id && toolResults.has(b.id)) {
          card.prettyResult = toolResults.get(b.id)
        } else if (isPrettyPrintTool(b.name) && b.id) {
          pendingPrettyPrint.set(b.id, { card })
          continue
        }
        cards.push(card)
      } else if (b.type === 'text' && b.text?.trim().length > 0) {
        cards.push({ tool: '_text', arg: b.text.slice(0, 60) })
      }
    }
  }
  for (const [id, text] of toolResults) {
    const pending = pendingPrettyPrint.get(id)
    if (!pending) continue
    pendingPrettyPrint.delete(id)
    cards.push({ ...pending.card, prettyResult: text })
  }
  return cards
}

let pass = true
const assert = (cond, msg) => { if (!cond) { pass = false; console.error('  ✗ FAIL:', msg) } else console.log('  ✓', msg) }

function codexOutputLine(output, type = 'function_call_output') {
  return JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: { type, call_id: 'call-test', output },
  })
}

console.log('\n=== unit fixtures ===')
{
  const ev = parseCodexLine(codexOutputLine('Wall time: 0.123 seconds\nOutput:\nhello\n'))
  assert(ev.blocks[0].text === 'hello\n', 'tool result strips Codex Wall time/Output envelope')
}
{
  const wrapped = 'Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"first"},{"type":"text","text":"second"}]'
  const ev = parseCodexLine(codexOutputLine(wrapped, 'custom_tool_call_output'))
  assert(ev.blocks[0].text === 'first\nsecond', 'MCP text-block JSON output unwraps to readable text')
}
{
  const original = 'Wall time: 0.123 seconds\nOutput:\n[{"type":"image","data":"x"}]'
  assert(unwrapCodexToolOutput(original) === '[{"type":"image","data":"x"}]', 'non-text JSON preserves stripped payload without guessing')
}
{
  const original = 'not a transcript envelope: [{"type":"text","text":'
  assert(unwrapCodexToolOutput(original) === original, 'non-envelope parse failures preserve original text')
}
{
  const ev = parseCodexLine(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Got it.' }],
    },
  }))
  const cards = extractCards([ev])
  assert(cards.some(c => c.tool === '_text' && c.arg === 'Got it.'),
    'short assistant messages produce text activity cards')
}
{
  const events = [
    parseCodexLine(JSON.stringify({
      type: 'response_item',
      timestamp: '2026-06-17T00:00:00.000Z',
      payload: {
        type: 'function_call',
        name: 'get_thread',
        namespace: 'mcp__tlda',
        arguments: JSON.stringify({ agent: 'bhist' }),
        call_id: 'call-thread',
      },
    })),
    parseCodexLine(codexOutputLine('Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"2 messages\\n\\n[6/18/2026, 8:00:00 AM] skip → bhist\\nhello"}]', 'function_call_output').replace('call-test', 'call-thread')),
  ].filter(Boolean)
  const cards = extractCards(events)
  const threadCard = cards.find(c => c.tool === 'tlda/get_thread')
  assert(threadCard?.arg === 'bhist', 'get_thread activity card keeps the requested agent as arg')
  assert(threadCard?.prettyResult?.includes('skip → bhist'), 'get_thread activity card attaches readable pretty result')
}
{
  const request = parseCodexLine(JSON.stringify({
    type: 'response_item',
    timestamp: '2026-06-17T00:00:00.000Z',
    payload: {
      type: 'function_call',
      name: 'get_thread',
      namespace: 'mcp__tlda',
      arguments: JSON.stringify({ agent: 'bhist' }),
      call_id: 'call-thread-delayed',
    },
  }))
  const firstCards = extractCards([request])
  assert(firstCards.length === 0, 'delayed pretty tool request waits for result instead of emitting bare card')
  const result = parseCodexLine(codexOutputLine('Wall time: 0.123 seconds\nOutput:\n[{"type":"text","text":"1 message\\n\\n[6/18/2026, 8:00:00 AM] skip → bhist\\nhello"}]', 'function_call_output').replace('call-test', 'call-thread-delayed'))
  const secondCards = extractCards([result])
  const delayedCard = secondCards.find(c => c.tool === 'tlda/get_thread')
  assert(delayedCard?.prettyResult?.includes('skip → bhist'), 'delayed pretty result emits original tool card shape')
  assert(!secondCards.some(c => c.tool === '_prettyResult'), 'delayed pretty result does not emit _prettyResult card')
}

function findRollouts() {
  const base = path.join(os.homedir(), '.codex', 'sessions')
  const out = []
  const walk = d => {
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(base)
  return out
}

const files = process.argv.slice(2).length ? process.argv.slice(2) : findRollouts()
if (!files.length) {
  console.log('\n(no rollout files found; unit fixtures only)')
  console.log(pass ? '\nALL PASS' : '\nSOME FAILURES')
  process.exit(pass ? 0 : 1)
}

for (const f of files) {
  console.log(`\n=== ${path.basename(f)} ===`)
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
  const events = lines.map(parseCodexLine).filter(Boolean)
  const cards = extractCards(events)
  const hasToolOutput = lines.some(line => line.includes('function_call_output') || line.includes('custom_tool_call_output'))

  const toolUses = events.flatMap(e => (e.blocks || []).filter(b => b.type === 'tool_use'))
  const toolResultIds = new Set(events.flatMap(e => (e.blocks || [])
    .filter(b => b.type === 'tool_result' && b.id)
    .map(b => b.id)))
  const fleetCalls = toolUses.filter(b => b.name.startsWith('mcp__tlda__'))
  const nativeCalls = toolUses.filter(b => !b.name.startsWith('mcp__tlda__'))
  const visibleCards = cards.filter(c => c.tool !== '_usage' && c.tool !== '_text')

  console.log(`  lines=${lines.length} events=${events.length} toolUses=${toolUses.length}` +
    ` (fleet=${fleetCalls.length} native=${nativeCalls.length}) cards=${cards.length}`)

  // 1. fleet tool calls normalize to mcp__tlda__<name>. Infrastructure tools
  //    are filtered as noise; selected tools are allowed through for
  //    pretty-printed result cards.
  if (fleetCalls.length) {
    assert(fleetCalls.every(b => /^mcp__tlda__/.test(b.name)),
      'fleet tools normalized to mcp__tlda__<name>')
    const noisyFleetNames = fleetCalls
      .filter(b => ACTIVITY_NOISE.has(b.name))
      .map(b => humanToolName(b.name))
    assert(!visibleCards.some(c => noisyFleetNames.includes(c.tool)),
      'fleet infrastructure calls suppressed as activity noise')
    const prettyFleetNames = fleetCalls
      .filter(b => !ACTIVITY_NOISE.has(b.name) && isPrettyPrintTool(b.name) && toolResultIds.has(b.id))
      .map(b => humanToolName(b.name))
    if (prettyFleetNames.length) {
      assert(prettyFleetNames.some(name => visibleCards.some(c => c.tool === name)),
        'pretty-print fleet tools can produce tlda/* cards')
    }
  }
  // 2. native shell (Codex exec_command) relabels to Claude 'Bash' and carries
  //    a non-empty command arg into the card
  const exec = nativeCalls.filter(b => b.name === 'Bash')
  if (exec.length) {
    const commandBackedExec = exec.filter(b => b.input.command != null)
    if (commandBackedExec.length) {
      assert(commandBackedExec.every(b => typeof b.input.command === 'string' && b.input.command.length),
        'exec_command aliased cmd→command')
    }
    const knownArgExec = exec.filter(b => b.input.file_path || b.input.path || b.input.command ||
      b.input.cat || b.input.pattern || b.input.message || b.input.query || b.input.description ||
      b.input.reason || b.input.agent || b.input.doc || b.input.ref || b.input.text)
    const execCards = visibleCards.filter(c => c.tool === 'Bash')
    assert(execCards.length === exec.length,
      'Bash calls produce Bash cards')
    assert(execCards.filter(c => c.arg.length).length >= knownArgExec.length,
      'Bash cards show known primary shell args')
    assert(!nativeCalls.some(b => b.name === 'exec_command'),
      'no literal exec_command leaks (all relabelled)')
  }
  // 2b. apply_patch (custom_tool_call) → Edit blocks with file_path + diff
  const edits = toolUses.filter(b => b.name === 'Edit')
  if (edits.length) {
    assert(edits.every(b => typeof b.input.file_path === 'string' && b.input.file_path.length),
      'apply_patch → Edit block(s) with file_path')
    const editsWithHunks = edits.filter(b => b.input.op !== 'delete')
    if (editsWithHunks.length) {
      assert(editsWithHunks.some(b => typeof b.input.diff === 'string' && /[-+]/.test(b.input.diff)),
        'Edit block carries the diff hunk')
    }
    const editCards = visibleCards.filter(c => c.tool === 'Edit')
    assert(editCards.length === edits.length && editCards.every(c => c.arg.length),
      'Edit produces a card with the file path as arg')
  }

  // 3. tool outputs become tool_result blocks matched by call_id
  const results = events.flatMap(e => (e.blocks || []).filter(b => b.type === 'tool_result'))
  if (hasToolOutput) {
    assert(results.length > 0, 'tool outputs parsed as tool_result blocks')
  }
  // 4. usage parsed from complete token_count records when present. Historical
  // rollout files can contain partial token_count-looking records, so do not
  // make the opportunistic scan fail on absent usage.
  const usage = events.find(e => e.usage)
  if (usage) {
    assert(!!usage && usage.usage.output >= 0, 'token usage parsed')
  }

  // show a few representative cards
  const sample = visibleCards.slice(0, 4).map(c => `${c.tool}(${c.arg})`).join('  |  ')
  if (sample) console.log('  cards:', sample)
}

console.log(pass ? '\nALL PASS' : '\nSOME FAILURES')
process.exit(pass ? 0 : 1)
