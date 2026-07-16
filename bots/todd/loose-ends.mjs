export const LOOSE_END_COOLDOWN_MS = 2 * 60 * 1000

export const LOOSE_END_REPORT_MSG = `Loose-end check: identify the next unresolved action you can do yourself. If responsibility remains, keep the task open and continue or assign that action; if the responsibility is over, close it with \`report({ close: true, summary })\`. If your message says "needs X", "unless X", "not verified", "not deployed", or "condition", either do X now, assign it, or state the true authority boundary.`

export const LOOSE_END_PROCESS_MSG = `Process check: Skip is having to pull the next step out of you. Stop reporting direction-finding. Continue until you have one of: worked proof/fix, concrete failure mode, concrete edit/proposal, or true authority boundary.`

export const LOOSE_END_REPORT_PATTERNS = [
  /\bStatus:/i,
  /\bRemaining:/i,
  /\bConclusion:/i,
  /\bConsequences:/i,
  /\bsource needs\b/i,
  /\bunless we\b/i,
  /\bwould require\b/i,
  /\bcondition(?:al)?\b/i,
  /\bnot deployed\b/i,
  /\bnot verified\b/i,
  /\bI did not\b/i,
]

export const LOOSE_END_PROCESS_PATTERNS = [
  /\bdo the work\b/i,
  /\bneeds? a lemma does not mean done\b/i,
  /\bwork on this direction\b.*\bproactive/i,
  /\bwork\b.*\bproactive/i,
  /\bstop reporting\b/i,
  /\bdon't make me\b/i,
  /\bdo not make me\b/i,
  /\bwhy are you asking me\b/i,
  /\bI still have to micromanage\b/i,
]

export function isLooseEndReport(text = '') {
  return LOOSE_END_REPORT_PATTERNS.some(p => p.test(text))
}

export function isLooseEndProcessCorrection(text = '') {
  return LOOSE_END_PROCESS_PATTERNS.some(p => p.test(text))
}

export function decideLooseEndNudge({
  fromId,
  toId,
  text = '',
  ownerId = 'fleet:skip',
  botId = 'fleet:todd',
  now = Date.now(),
  lastSent = new Map(),
  cooldownMs = LOOSE_END_COOLDOWN_MS,
} = {}) {
  let agentId = null
  let kind = null
  let message = null

  if (fromId === ownerId && toId && toId !== botId) {
    if (isLooseEndProcessCorrection(text)) {
      agentId = toId
      kind = 'process'
      message = LOOSE_END_PROCESS_MSG
    }
  } else if (fromId && fromId !== ownerId && fromId !== botId && toId === ownerId) {
    if (isLooseEndReport(text)) {
      agentId = fromId
      kind = 'report'
      message = LOOSE_END_REPORT_MSG
    }
  }

  if (!agentId) return null

  const key = `${kind}:${agentId}`
  const last = lastSent.get(key) || 0
  if (now - last < cooldownMs) return null
  lastSent.set(key, now)

  return { agentId, kind, message, key }
}
