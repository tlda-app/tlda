// Shared agent status state-machine primitives.
//
// The daemon runs ONE armed/scan/idle/disarm state machine for EVERY harness
// (claude, codex, goose). The only harness-specific part is `classifyPane` —
// reading thinking/compacting/approval truth out of a captured pane. Everything
// else (when to watch an agent, the idle hysteresis, when to stop watching) is
// identical across harnesses. These functions are PURE and table-testable; the
// daemon owns the per-agent state maps and supplies `now`.

import { resolveGooseStatus } from './goose-kick.mjs'

// claude / codex spinner + chrome. Skip: "they all have the same spinner
// behavior, just a different regex" — so the per-harness difference lives ONLY
// in classifyPane, not in the machine around it.
export const THINKING_SPINNER_RE = /[A-Z][a-z]+ing…/
export const INTERRUPT_HINT_RE = /esc to interrupt/
export const COMPACTING_RE = /Compacting conversation/
export const APPROVAL_PROMPT_RE = /[○●]\s*Allow once|Allow this .{0,30}\?\s*\(y\/n\)|Esc to cancel\s*·\s*Tab to amend/i
export const THINKING_SCAN_LINES = 40
export const APPROVAL_PROMPT_SCAN_LINES = 15

function lastLines(s, n) {
  return String(s).split('\n').slice(-n).join('\n')
}

// Per-harness pane → status classifier. The ONLY harness-specific code in the
// status machine. Stateful for goose (freeze→stuck tracking via resolveGooseStatus);
// stateless for claude/codex. Returns the display truth plus any carried classifier
// state to thread back next scan.
//   prevState / now : used only by the goose classifier (freeze tracking)
// Returns { thinking, compacting, approval, approvalFp, state }.
export function classifyPane(harnessKind, pane, prevState = null, now = 0) {
  if (harnessKind === 'goose') {
    // resolveGooseStatus escalates a frozen-but-spinning goose to 'stuck', so a
    // wedged goose reads thinking:false (turn really ended) instead of a spinner
    // stuck on forever.
    const { status, live } = resolveGooseStatus(pane, prevState, now)
    return {
      thinking: status === 'working',
      compacting: status === 'compacting',
      approval: false,
      approvalFp: null,
      state: live,
    }
  }
  // claude / codex share the claude classifier (same spinner behavior). If a
  // codex-specific spinner ever appears, add a `codex` branch here — nothing in
  // the surrounding machine changes.
  const bottom = lastLines(pane, THINKING_SCAN_LINES)
  const thinking = THINKING_SPINNER_RE.test(bottom) || INTERRUPT_HINT_RE.test(bottom)
  const compacting = COMPACTING_RE.test(pane)
  const approvalBottom = lastLines(pane, APPROVAL_PROMPT_SCAN_LINES)
  const approval = APPROVAL_PROMPT_RE.test(approvalBottom)
  return {
    thinking,
    compacting,
    approval,
    approvalFp: approval ? approvalBottom.slice(-100) : null,
    state: null,
  }
}

// PURE hysteresis for the agent-thinking edge. A single missed spinner frame must
// never fabricate a turn end, so the false edge only fires after `confirm`
// consecutive idle scans. The true edge fires immediately (status must feel live).
//   prev      : last emitted thinking bool
//   idleCount : consecutive non-thinking scans observed while prev was true
// Returns { emit: true|false|null, prev, idleCount } — emit is the edge to send
// (null = no change), prev/idleCount are the next state to store.
export function decideThinkingEdge(prev, idleCount, isThinking, confirm = 2) {
  if (isThinking) {
    return { emit: prev ? null : true, prev: true, idleCount: 0 }
  }
  if (!prev) return { emit: null, prev: false, idleCount: 0 }
  const n = idleCount + 1
  if (n >= confirm) return { emit: false, prev: false, idleCount: 0 }
  return { emit: null, prev: true, idleCount: n }
}

// PURE: an armed agent stays armed while busy (thinking/compacting) and for a
// linger window after, then disarms — so a quick next turn isn't missed but an
// idle agent stops costing pane pulls.
export function shouldDisarm(now, armedAt, busy, lingerMs) {
  return !busy && (now - armedAt > lingerMs)
}

// Prompt/attention detection uses deep pane captures, so it must follow the
// same event-armed boundary as thinking/compacting. A previously surfaced prompt
// keeps the session eligible long enough to clear or update that prompt.
export function shouldPromptSweepAgent(agent, { armed = false, surfaced = false } = {}) {
  if (!agent || agent.dead || agent.human || agent.hibernating || !agent.tmux_session) return false
  return !!armed || !!surfaced
}
