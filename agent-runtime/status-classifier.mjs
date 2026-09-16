// Shared agent status state-machine primitives.
//
// The daemon runs ONE armed/scan/idle/disarm state machine for EVERY harness
// (claude, codex, goose). The only harness-specific part is `classifyPane` —
// reading thinking/compacting/approval truth out of a captured pane. Everything
// else (when to watch an agent, the idle hysteresis, when to stop watching) is
// identical across harnesses. These functions are PURE and table-testable; the
// daemon owns the per-agent state maps and supplies `now`.

import { resolveGooseStatus } from './goose-kick.mjs'
import { isObservableDaemonProcessBinding } from './daemon-process-binding.mjs'

// claude / codex spinner + chrome. Skip: "they all have the same spinner
// behavior, just a different regex" — so the per-harness difference lives ONLY
// in classifyPane, not in the machine around it.
export const THINKING_SPINNER_RE = /[A-Z][a-z]+ing…/
export const INTERRUPT_HINT_RE = /esc to interrupt/
export const COMPACTING_RE = /Compacting conversation/
export const APPROVAL_PROMPT_RE = /[○●]\s*Allow once|Allow this .{0,30}\?\s*\(y\/n\)|Esc to cancel\s*·\s*Tab to amend/i
export const THINKING_SCAN_LINES = 40
export const APPROVAL_PROMPT_SCAN_LINES = 15

// The permission mode showing in a Claude Code footer.
//
// ONE parser, here, because there were two and they disagreed. `unified-server`
// and `routes/fleet` each carried a private `parseCCMode`, and only the latter
// had the `auto` branch — so the same pane answered `default` in one and `auto`
// in the other. They agreed in production only by accident: both read a field
// the daemon does not send (`cap.content` against `rpcCapturePane`'s `pane`), so
// both always parsed `''` and both always said `default`. Fixing the read is
// what would have made them start contradicting each other, which is why the
// parser had to be collapsed in the same change rather than after it.
//
// `bypass permissions on` is the literal footer text on most agents here, so
// reporting it as `default` is false rather than merely coarse. That is what
// makes `auto` correct rather than a preference.
//
// Verified against live panes rather than invented: an agent was cycled through
// its own footer with shift+tab and each state captured — `⏵⏵ bypass permissions
// on`, `⏵⏵ accept edits on`, `plan mode on`. Note `plan mode on` carries no `⏵⏵`
// prefix, so nothing here may key on that glyph.
export function parsePermissionMode(pane) {
  const text = String(pane || '')
  if (/plan mode on/i.test(text)) return 'plan'
  if (/accept edits on/i.test(text)) return 'acceptEdits'
  if (/auto.approve/i.test(text) || /bypass/i.test(text)) return 'auto'
  return 'default'
}

// How many shift+tabs reach plan mode from `mode`.
//
// The cycle is bypass/default → acceptEdits → plan → back, confirmed by walking
// a live agent through it. From `plan` one press leaves it; from `acceptEdits`
// one press reaches plan; from anything else two. `auto` falls in the last
// branch and that is correct — a bypass agent takes two presses, observed.
export function permissionModeKeypresses(mode) {
  return mode === 'plan' || mode === 'acceptEdits' ? 1 : 2
}

function lastLines(s, n) {
  return String(s).split('\n').slice(-n).join('\n')
}

// Per-harness pane → status classifier. The ONLY harness-specific code in the
// status machine. Stateful for goose (freeze→stuck tracking via resolveGooseStatus);
// stateless for claude/codex. Returns the display truth plus any carried classifier
// state to thread back next scan.
//   prevState / now : used only by the goose classifier (freeze tracking)
// Returns { thinking, compacting, approval, approvalFp, state }.
// agy turn signals, measured against the live TUI 2026-09-16. The footer
// carries `esc to cancel` (lowercase) while a turn is live -- working or
// awaiting approval -- and `? for shortcuts` when idle. Thought/tool lines
// (`▸ Thought for 2s, 290 tokens`, `● Bash(...)`) persist in the transcript,
// so they must NOT count as thinking; only the live footer does. Approval
// dialogs ask `Run this command?` / `Allow access to this file?` with
// numbered options; the workspace trust dialog asks `Do you trust the
// contents of this project?` and is NOT an approval (the injector confirms
// it, the guard below never auto-confirms an approval).
const AGY_LIVE_FOOTER_RE = /esc to cancel/
export const AGY_APPROVAL_RE = /Run this command\?|Allow access to this file\?|Requesting permission for:/
export const AGY_TRUST_DIALOG_RE = /Do you trust the contents of this project\?/
export function classifyPane(harnessKind, pane, prevState = null, now = 0) {
  if (harnessKind === 'agy') {
    const tail = lastLines(pane, 12)
    const approval = AGY_APPROVAL_RE.test(tail)
    return {
      thinking: !approval && AGY_LIVE_FOOTER_RE.test(lastLines(pane, 5)),
      compacting: false,
      approval,
      approvalFp: approval ? tail.slice(-100) : null,
      state: null,
    }
  }
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

// Which character starts the harness's composer line. Codex draws `›`, Claude
// draws `❯`, agy draws `>`; goose has no composer we drive, so it has no
// entry rather than a guessed one.
const COMPOSER_PROMPT = Object.freeze({ codex: '›', claude: '❯', agy: '>' })

const BUSY_MARKERS = Object.freeze([
  'Working', 'Transmuting', 'Thinking', 'esc to interrupt', 'ESC to interrupt',
])

// The leading slice of a kickoff we can expect to find on ONE composer line.
// Every caller asking "is my kickoff parked?" must derive it the same way, or a
// recovery looks for a marker the injector never matched on.
export function kickoffMarker(prompt = '') {
  const text = String(prompt)
  return text.slice(0, Math.min(text.length, 48))
}

// PURE: what the harness's composer currently holds, and whether the harness is
// working below it.
//
// This is the reading behind "the process is alive and no turn was produced":
// the kickoff sits at the composer, unsent, and nothing is running underneath.
// From outside that is indistinguishable from a dead mint -- live process, live
// tmux session, silence -- which is why it produced three different symptom
// names and no diagnosis.
//
// `marker` is the text we are asking about, normally the first characters of a
// kickoff we sent. Asking whether OUR text is parked is deliberate: a composer
// that merely looks non-empty may be holding a placeholder hint, or something a
// person typed and has not sent, and neither is ours to submit.
// A composer rendering text next to the prompt looks identical whether that text
// is PENDING INPUT or a dim ghost -- a saved unsent draft, or the harness's own
// placeholder hint. `capture-pane -p` strips the attributes, so the one bit that
// tells them apart is gone before anything can read it. Measured on a real codex
// pane 2026-09-12:
//
//   empty:  ESC[1m›ESC[0m ESC[2mAsk Codex to do anythingESC[0m
//   typed:  ESC[1m›ESC[0m Call login() with the tlda MCP server and check inbox
//
// So a ghost is a dim SGR-2 span and live input is not, and a caller that wants
// the difference must capture with `-e` and pass `escapes: true`. Without that,
// a dim ghost of a kickoff reads as a parked kickoff -- which would report a
// healthy agent as never started, the exact class this file exists to get right.
//
// Found by `untracked-sessions`, who flagged it against this code rather than
// asserting it, after their own `[queue-operation]` reading turned out to be a
// ghost over an empty buffer.
// THERE ARE TWO DIM RENDERINGS NEAR THE PROMPT AND THEY MEAN OPPOSITE THINGS.
// Measured, by `notify-does-not-wake` and confirmed against a live claude pane:
//
//   ESC[2m …            dimmed foreground  -> placeholder, buffer EMPTY
//   ESC[48;5;237m …     highlighted BLOCK  -> a genuinely QUEUED, unconsumed prompt
//   plain text                             -> real typed input
//
// So a foreground dim is a placeholder and a background highlight is real work
// waiting. Conflating them is what made an earlier "19 agents are stuck" count a
// sum of two different states. **Background spans are deliberately left alone**:
// a queued unconsumed prompt is real pending input, and for the parked-kickoff
// case it is exactly the state worth acting on.
//
// A GREYSCALE RANGE WAS TRIED HERE AND REVERTED, because grey is used for real
// content as well. Measured on a live claude pane: the trust dialog colours every
// word separately and wraps its `1.` in `38;5;246`, so a greyscale rule deleted
// real dialog text. And it was never needed -- both harnesses render their
// placeholder as SGR 2, real typed input arrives PLAIN, and the `38;5;246` that
// prompted the range turns out to wrap the prompt GLYPH on an empty composer
// rather than any ghost text. Enumerating colours failed the same way
// enumerating dialogs does.
const GHOST_SPAN_RE = /\x1b\[2m.*?(?:\x1b\[(?:0|39)m|$)/g
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g

export function stripGhostSpans(text = '') {
  return String(text).replace(GHOST_SPAN_RE, '').replace(ANSI_RE, '')
}

// A PANE-CONTENT MATCH AND A KEYSTROKE TARGET ARE DIFFERENT ADDRESSES.
// `notify-does-not-wake`, 2026-09-12, and it is the whole rule: matching text
// somewhere in a pane licenses nothing about what currently has focus. Enter
// goes to the focused widget, so a composer match plus an Enter can confirm a
// dialog that happens to be up.
//
// Measured on a probe carrying three queued kickoff prompts AND a dev-channels
// dialog whose highlighted default was `1. I am using this for local
// development`. A recovery keyed on the composer would have confirmed it.
//
// So: anything about to send a keystroke asks this first and refuses if it is
// true. It is deliberately COARSE -- any dialog, recognised or not -- because
// the alternative is enumerating dialogs, which is the treadmill that produced
// a third unrecognised case within a day of there being two.
//
// **Run this on the raw pane rather than on ghost-stripped text.** A safety
// check should not be handed a lossily filtered input on principle -- and the
// specific hazard was real while a greyscale range was in `GHOST_SPAN_RE`: the
// trust dialog wraps its `1.` in `38;5;246`, so stripping deleted dialog text
// and this check passed on the exact pane it exists to catch. **That range has
// since been reverted**, so stripping no longer eats it and the raw-pane rule is
// now belt-and-braces rather than load-bearing. Kept, because the filter above
// may grow again and this check must not depend on what it currently removes.
const DIALOG_KEYPRESS_RE = /Enter to confirm|Esc to cancel|❯\s*\d\.\s|Press enter to continue|Run this command\?|Allow access to this file\?/
export function dialogAwaitingKeypress(pane = '', tailLines = 25) {
  const tail = String(pane).split('\n').slice(-tailLines).join('\n')
  return DIALOG_KEYPRESS_RE.test(tail.replace(ANSI_RE, ''))
}

export function composerState(harnessKind, pane = '', marker = '', { escapes = false } = {}) {
  const prompt = COMPOSER_PROMPT[harnessKind]
  const absent = { promptIndex: -1, containsMarker: false, busyAfter: false }
  if (!prompt) return absent
  const source = escapes
    ? String(pane).split('\n').map(stripGhostSpans).join('\n')
    : String(pane)
  const lines = source.split('\n')
  if (harnessKind === 'agy') return agyComposerState(lines, marker, absent)
  const promptIndex = harnessKind === 'codex'
    ? lines.findLastIndex((line) => line.trimStart().startsWith(prompt))
    : lines.findLastIndex((line) => line.includes(prompt))
  if (promptIndex < 0) return absent
  return {
    promptIndex,
    containsMarker: !!marker && lines[promptIndex].includes(marker),
    busyAfter: lines.slice(promptIndex + 1).some((line) =>
      BUSY_MARKERS.some((busy) => line.includes(busy))),
  }
}

// agy keeps submitted prompts in scrollback as `> text` lines, so "the last
// `>` line holds our text" is true both parked AND submitted. The difference
// is what follows it: a parked kickoff sits in the live composer (only the
// ── rule and the `? for shortcuts` idle footer below it), while a submitted
// one has turn output (`▸ Thought…`, `● Tool(…)`, response text) below it.
// A live turn -- working or awaiting approval -- carries `esc to cancel` in
// the tail. Approval/option lines (`> 1. Yes, …`) never carry our marker.
function agyComposerState(lines, marker, absent) {
  const promptIndex = lines.findLastIndex((line) => line.trimStart().startsWith('>'))
  if (promptIndex < 0) return absent
  const after = lines.slice(promptIndex + 1)
  const afterText = after.join('\n')
  const produced = after.some((line) => line.includes('▸ Thought') || line.trimStart().startsWith('●'))
  return {
    promptIndex,
    containsMarker: !!marker && lines[promptIndex].includes(marker) && !produced,
    busyAfter: AGY_LIVE_FOOTER_RE.test(afterText),
  }
}

// PURE hysteresis for the thinking activity transition. A single missed spinner frame must
// never fabricate a turn end, so the false edge only fires after `confirm`
// consecutive idle scans. The true edge fires immediately (status must feel live).
//   prev      : last emitted thinking bool
//   idleCount : consecutive non-thinking scans observed while prev was true
// Returns { emit: true|false|null, prev, idleCount }; the scanner carries `prev`
// in its next complete status result.
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
  if (!isObservableDaemonProcessBinding(agent)) return false
  return !!armed || !!surfaced
}
