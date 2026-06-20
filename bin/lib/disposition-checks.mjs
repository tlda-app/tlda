// Pure disposition checks for the turn-end self-check bot (bin/disposition-bot.mjs).
//
// Each check looks at the turn that just ended — the agent's last message TO
// Skip (`lastMsgText`, what it CLAIMED) and the concatenated tool activity in
// the turn (`activityText`, what it DID) — and returns { label, message } if it
// fires, else null. The bot runs them in order and fires at most one.
//
// Triggers are from scratch/disposition-mine/TAXONOMY.md. SELECTIVITY is the
// point: each check requires a conjunction that's naturally rare (a done-claim
// AND no verification; a Skip-facing punt) so the bot stays quiet on ordinary
// turns instead of becoming wallpaper.

// ── A — done-claim without verification (TAXONOMY #1) ──────────────────────
export const DONE_CLAIM_RE = /\b(?:it'?s |all )?(?:done|fixed|shipped|deployed|live now|working now|works now|it works|good to go|ready (?:to (?:test|use|go|review)|for you)|all set|landed|merged|complete(?:d)?|verified|confirmed working)\b/i
// Negations / non-claims carrying the same words ("not done", "when done",
// "almost done", "couldn't verify") — if present, it's not an assertive claim.
export const NOT_A_CLAIM_RE = /\b(?:not (?:done|fixed|working|verified|deployed)|isn'?t (?:done|fixed|working)|when (?:it'?s |you'?re )?done|almost done|not yet|still (?:need|working|broken)|can'?t verify|couldn'?t verify|unverified)\b/i
// Evidence the agent checked the surface this turn (seen in its tool activity).
export const VERIFICATION_RE = /\b(?:tlda-dev pw|playwright|screenshot|curl\b|npm (?:run )?test|vitest|pytest|jest|tlda doc preview|doc preview|\.test\.|spec\.|assert)\b/i

const DONE_MSG = `🪞 **Turn-end self-check — done-claim without verification.** Your turn ended telling Skip the work is done/working, but this turn shows no check on the surface he actually uses (no screenshot / \`tlda-dev pw\` / test run / curl / preview).

Before "done" stands, answer three things — to yourself, then in your report:
1. **Did I break what already worked?** (not just: does my new thing work)
2. **Is my evidence on the surface Skip actually touches** — the rendered app, the real output — not a DOM count or a log line?
3. **Is that evidence conclusive**, or am I reading ambiguous output charitably?

If you can't answer all three with evidence, it isn't done — go verify, then report. Read \`verification-before-completion\` and \`self-sufficiency\`.`

export function checkDoneWithoutVerification(lastMsgText, activityText = '') {
  if (!lastMsgText) return null
  if (!DONE_CLAIM_RE.test(lastMsgText)) return null
  if (NOT_A_CLAIM_RE.test(lastMsgText)) return null
  if (VERIFICATION_RE.test(activityText)) return null // they DID verify — fine
  return { label: 'untouched-surface', message: DONE_MSG }
}

// ── C — make-him-steer / punt (TAXONOMY #3), PUNT-only in v1 ────────────────
// Only the high-precision form fires here: a DIRECTIVE telling Skip to go check
// something himself ("try it", "reload and check", "let me know if it works").
// The softer "loose-end report" form ("not deployed", "would require") is
// DELIBERATELY left out: at a turn boundary, regex can't tell an honest
// scope-boundary statement (which the taxonomy says is fine) from a real punt,
// so firing on it scolds legitimate reports. todd's existing loose-end watchdog
// (decideLooseEndNudge) already covers that case on the message itself, with
// the cooldowns and process-correction context this bot lacks.
export const PUNT_RE = /\b(?:you (?:can |should |could )?(?:try|check|verify|test) (?:it|this|that)|reload and (?:check|see)|let me know if (?:it|that|this) works|give it a (?:try|shot)|see if (?:it|that|this) works|test it (?:on|in) (?:the )?(?:browser|safari|ipad|iphone)|check (?:it|this|that) on your end)\b/i

const PUNT_MSG = `🪞 **Turn-end self-check — you ended by asking Skip to check something himself.** He's hands-free (RSI, voice input) — "try it / reload and check / let me know if it works" makes him do the work that's yours.

Verify it yourself — screenshot, \`tlda-dev pw\`, curl, a test — then report the result. Never hand him a "go see if it works." Read \`self-sufficiency\`.`

export function checkMakeHimSteer(lastMsgText, _activityText = '') {
  if (!lastMsgText) return null
  if (PUNT_RE.test(lastMsgText)) return { label: 'dont-make-him-steer', message: PUNT_MSG }
  return null
}

// Order matters: punt is checked FIRST, so a directive like "let me know if it
// works" is labeled a punt rather than tripping the "it works" done-claim.
export const CHECKS = [checkMakeHimSteer, checkDoneWithoutVerification]

export function runChecks(lastMsgText, activityText = '') {
  for (const check of CHECKS) {
    const hit = check(lastMsgText, activityText)
    if (hit) return hit
  }
  return null
}
