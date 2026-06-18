// Test parseCodexLine against real captured Codex rollouts.
// Run: node bin/codex-activity.test.mjs [path-to-rollout.jsonl ...]
// With no args, scans ~/.codex/sessions for rollout-*.jsonl.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseCodexLine } from './lib/codex-activity.mjs'

// --- faithful copy of the bits of extractActivityEvents we exercise ---
// (kept in sync with fleet-daemon.mjs; this test exists to prove the Codex
// parser feeds those functions the right shape.)
const ACTIVITY_NOISE = new Set([
  'wait_for_task', 'my_task', 'task_list', 'register', 'register_manager',
  'task_check', 'unregister_manager', 'task_done', 'timer',
  'chat', 'delegate', 'report', 'share', 'spawn', 'respawn', 'interrupt',
  'name_agent', 'label_agent', 'observe', 'promote', 'cleanup',
  'mcp__tlda__wait_for_task', 'mcp__tlda__my_task', 'mcp__tlda__task_list',
  'mcp__tlda__register', 'mcp__tlda__register_manager', 'mcp__tlda__task_check',
  'mcp__tlda__task_done', 'mcp__tlda__timer',
  'mcp__tlda__chat', 'mcp__tlda__delegate', 'mcp__tlda__report',
  'mcp__tlda__share', 'mcp__tlda__spawn', 'mcp__tlda__respawn',
  'mcp__tlda__interrupt', 'mcp__tlda__name_agent', 'mcp__tlda__label_agent',
  'mcp__tlda__observe', 'mcp__tlda__promote', 'mcp__tlda__cleanup',
  'ToolSearch',
])
const PRETTY_PRINT_TOOLS = new Set([
  'mcp__tlda__search_logs',
  'mcp__tlda__get_thread',
  'ScheduleWakeup',
  'mcp__tlda__screenshot',
  'mcp__tlda__propose_edit',
])
const humanToolName = name => name.replace(/^mcp__/, '').replace(/__/g, '/')
function extractCards(events) {
  const cards = []
  for (const ev of events) {
    if (ev.usage) cards.push({ tool: '_usage', usage: ev.usage })
    if (!ev.blocks) continue
    for (const b of ev.blocks) {
      if (ev.type === 'user' && b.type === 'text') continue
      if (b.type === 'tool_use') {
        if (ACTIVITY_NOISE.has(b.name)) continue
        const humanName = humanToolName(b.name)
        const input = b.input || {}
        const arg = input.file_path || input.path || input.command || input.pattern ||
          input.message || input.query || input.description || input.reason || ''
        cards.push({ tool: humanName, arg: String(arg).slice(0, 80) })
      } else if (b.type === 'text' && b.text?.length > 20) {
        cards.push({ tool: '_text', arg: b.text.slice(0, 60) })
      }
    }
  }
  return cards
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
if (!files.length) { console.error('no rollout files found'); process.exit(1) }

let pass = true
const assert = (cond, msg) => { if (!cond) { pass = false; console.error('  ✗ FAIL:', msg) } else console.log('  ✓', msg) }

for (const f of files) {
  console.log(`\n=== ${path.basename(f)} ===`)
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
  const events = lines.map(parseCodexLine).filter(Boolean)
  const cards = extractCards(events)

  const toolUses = events.flatMap(e => (e.blocks || []).filter(b => b.type === 'tool_use'))
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
      .filter(b => PRETTY_PRINT_TOOLS.has(b.name))
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
    assert(exec.every(b => typeof b.input.command === 'string' && b.input.command.length),
      'exec_command aliased cmd→command')
    const execCards = visibleCards.filter(c => c.tool === 'Bash')
    assert(execCards.length === exec.length && execCards.every(c => c.arg.length),
      'exec_command relabelled to Bash, card shows the command as arg')
    assert(!nativeCalls.some(b => b.name === 'exec_command'),
      'no literal exec_command leaks (all relabelled)')
  }
  // 2b. apply_patch (custom_tool_call) → Edit blocks with file_path + diff
  const edits = toolUses.filter(b => b.name === 'Edit')
  if (edits.length) {
    assert(edits.every(b => typeof b.input.file_path === 'string' && b.input.file_path.length),
      'apply_patch → Edit block(s) with file_path')
    assert(edits.some(b => typeof b.input.diff === 'string' && /[-+]/.test(b.input.diff)),
      'Edit block carries the diff hunk')
    const editCards = visibleCards.filter(c => c.tool === 'Edit')
    assert(editCards.length === edits.length && editCards.every(c => c.arg.length),
      'Edit produces a card with the file path as arg')
  }

  // 3. tool outputs become tool_result blocks matched by call_id
  const results = events.flatMap(e => (e.blocks || []).filter(b => b.type === 'tool_result'))
  if (toolUses.length) {
    assert(results.length > 0, 'tool outputs parsed as tool_result blocks')
  }
  // 4. usage parsed from token_count
  const usage = events.find(e => e.usage)
  assert(!!usage && usage.usage.output >= 0, 'token usage parsed')

  // show a few representative cards
  const sample = visibleCards.slice(0, 4).map(c => `${c.tool}(${c.arg})`).join('  |  ')
  if (sample) console.log('  cards:', sample)
}

console.log(pass ? '\nALL PASS' : '\nSOME FAILURES')
process.exit(pass ? 0 : 1)
