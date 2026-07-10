// Run: node tests/status-classifier.test.mjs
// Table tests for the shared status state-machine primitives:
//   - classifyPane()      : per-harness pane → {thinking,compacting,approval} (the
//                           ONLY harness-specific part; claude/codex share a regex,
//                           goose uses its own markers + freeze→stuck escalation)
//   - decideThinkingEdge(): anti-flicker hysteresis (false edge needs N idle scans)
//   - shouldDisarm()      : armed → idle-past-linger → disarm
//   - shouldPromptSweepAgent(): prompt scans stay event-armed
import assert from 'node:assert/strict'
import { classifyPane, decideThinkingEdge, shouldDisarm, shouldPromptSweepAgent, THINKING_SPINNER_RE } from '../agent-runtime/status-classifier.mjs'

let passed = 0
function t(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`) }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1 }
}

// ---- classifyPane: claude / codex (shared spinner classifier) ----
t('claude spinner glyph → thinking', () => {
  assert.equal(classifyPane('claude', 'line1\nForging… (5s)\nline3').thinking, true)
})
t('claude "esc to interrupt" → thinking', () => {
  assert.equal(classifyPane('claude', 'doing stuff\n  esc to interrupt').thinking, true)
})
t('claude idle prompt → not thinking', () => {
  assert.equal(classifyPane('claude', 'all done.\n> ').thinking, false)
})
t('claude compacting', () => {
  assert.equal(classifyPane('claude', 'Compacting conversation…').compacting, true)
})
t('claude approval prompt → approval + fingerprint', () => {
  const c = classifyPane('claude', '○ Allow once  ● Always')
  assert.equal(c.approval, true)
  assert.ok(c.approvalFp && c.approvalFp.length > 0)
})
t('codex shares the claude classifier (same code path)', () => {
  assert.equal(classifyPane('codex', 'Thinking…').thinking, true)
  assert.equal(classifyPane('codex', 'idle > ').thinking, false)
})
t('codex REAL working line ("esc to interrupt", no ellipsis) → thinking via interrupt-hint', () => {
  // Captured live 2026-06-21 from a gpt-5.5 codex agent (codexops) while working:
  //   "• Working (4s • esc to interrupt)"
  // codex's spinner word "Working" has no ellipsis, so THINKING_SPINNER_RE misses
  // it — the interrupt-hint branch is what makes the shared classifier catch codex.
  assert.equal(classifyPane('codex', '• Working (4s • esc to interrupt)').thinking, true)
})

// ---- classifyPane: goose (own markers, stateful freeze→stuck) ----
t('goose working (Ctrl+C hint) → thinking', () => {
  assert.equal(classifyPane('goose', '◐ cooking\nCtrl+C to interrupt', null, 1000).thinking, true)
})
t('goose idle ("Enter to send") → not thinking', () => {
  assert.equal(classifyPane('goose', 'reply here\nEnter to send', null, 1000).thinking, false)
})
t('goose compacting', () => {
  assert.equal(classifyPane('goose', '◑ goose is compacting the conversation', null, 1000).compacting, true)
})
t('goose frozen pane escalates to stuck → thinking false', () => {
  const pane = '◐ working\nCtrl+C to interrupt'
  const first = classifyPane('goose', pane, null, 0)
  assert.equal(first.thinking, true)                // live spinner at t=0
  const later = classifyPane('goose', pane, first.state, 90_001) // same pane 90s+ later
  assert.equal(later.thinking, false)               // byte-identical too long → stuck, not thinking
})

// ---- decideThinkingEdge: hysteresis ----
t('idle→thinking emits true immediately', () => {
  assert.deepEqual(decideThinkingEdge(false, 0, true, 2), { emit: true, prev: true, idleCount: 0 })
})
t('still thinking emits nothing', () => {
  assert.deepEqual(decideThinkingEdge(true, 0, true, 2), { emit: null, prev: true, idleCount: 0 })
})
t('first idle scan holds (no false edge yet)', () => {
  assert.deepEqual(decideThinkingEdge(true, 0, false, 2), { emit: null, prev: true, idleCount: 1 })
})
t('second consecutive idle scan emits false', () => {
  assert.deepEqual(decideThinkingEdge(true, 1, false, 2), { emit: false, prev: false, idleCount: 0 })
})
t('thinking again mid-hold resets the idle counter (no false edge)', () => {
  assert.deepEqual(decideThinkingEdge(true, 1, true, 2), { emit: null, prev: true, idleCount: 0 })
})
t('already idle stays idle, emits nothing', () => {
  assert.deepEqual(decideThinkingEdge(false, 0, false, 2), { emit: null, prev: false, idleCount: 0 })
})

// ---- shouldDisarm ----
t('busy agent never disarms', () => {
  assert.equal(shouldDisarm(100000, 0, true, 8000), false)
})
t('idle within linger stays armed', () => {
  assert.equal(shouldDisarm(10000, 5000, false, 8000), false)
})
t('idle past linger disarms', () => {
  assert.equal(shouldDisarm(20000, 5000, false, 8000), true)
})

// ---- shouldPromptSweepAgent ----
const liveAgent = { id: 'fleet:a', tmux_session: 'sess' }
t('prompt sweep skips unarmed idle agents', () => {
  assert.equal(shouldPromptSweepAgent(liveAgent, { armed: false, surfaced: false }), false)
})
t('prompt sweep includes armed agents', () => {
  assert.equal(shouldPromptSweepAgent(liveAgent, { armed: true, surfaced: false }), true)
})
t('prompt sweep keeps surfaced prompt sessions eligible', () => {
  assert.equal(shouldPromptSweepAgent(liveAgent, { armed: false, surfaced: true }), true)
})
t('prompt sweep excludes dead/human/hibernating/no-session agents', () => {
  assert.equal(shouldPromptSweepAgent({ ...liveAgent, dead: true }, { armed: true }), false)
  assert.equal(shouldPromptSweepAgent({ ...liveAgent, human: true }, { armed: true }), false)
  assert.equal(shouldPromptSweepAgent({ ...liveAgent, hibernating: true }, { armed: true }), false)
  assert.equal(shouldPromptSweepAgent({ id: 'fleet:a' }, { armed: true }), false)
})

// regex sanity — the claude spinner is a capitalized "...ing…"
t('THINKING_SPINNER_RE matches a capitalized -ing word with ellipsis', () => {
  assert.equal(THINKING_SPINNER_RE.test('Cooking…'), true)
  assert.equal(THINKING_SPINNER_RE.test('cooking...'), false) // needs the … ellipsis + capital
})

console.log(`\n${passed} passed`)
