const STATUS_WORD_RE = /\b(status|checked|changed|remaining|conclusion|blocked|done|handled|fixed|passing|verified|handoff|next)\b/i
const COMPLETION_RE = /\b(done|handled|fixed|passing|complete|shipped|resolved)\b/i
const REMAINING_RE = /\b(remaining|still needs?|needs?|next|unless|condition|not verified|not deployed|would require)\b/i
const BLOCKER_RE = /\b(blocked|cannot|can't|waiting|depends on|stuck)\b/i
const HANDOFF_RE = /\b(handoff|hand off|someone else|next agent|pick up|continue from)\b/i
const UNCERTAINTY_RE = /\b(maybe|seems|likely|I think|not sure|unclear)\b/i

const VERIFICATION_RE = /\b(checked|verified|tested|passed|build passed|surface|browser|playwright|my_task|git status|npm run|node --test)\b/i
const NEXT_ACTION_RE = /\b(I will|I'll|doing|running|checking|testing|assign|assigned|delegate|delegated|timer|checkback|scheduled|retry|falsify|prove|implement)\b/i
const OWNER_RE = /\b(owner|assigned to|delegated to|fleet:|agent)\b/i
const TIMER_RE = /\b(timer|checkback|scheduled|remind|wake)\b/i
const BOUNDARY_RE = /\b(authority boundary|true blocker|external|waiting for Skip|requires Skip|permission|locked by Skip|user lock)\b/i
const PROVENANCE_RE = /\b(message id|id:|timestamp|since:|until:|get_thread|commit|line|file|provenance|reopen)\b/i
const SUCCESS_RE = /\b(success criteria|checked|verified|expected|surface|done when)\b/i

export function isDisclosureCandidate(text = '') {
  return (
    STATUS_WORD_RE.test(text) ||
    COMPLETION_RE.test(text) ||
    REMAINING_RE.test(text) ||
    BLOCKER_RE.test(text) ||
    HANDOFF_RE.test(text) ||
    UNCERTAINTY_RE.test(text)
  )
}

export function extractDisclosureFeatures(event = {}) {
  const text = event.text || ''
  const context = event.context || {}

  const claimsCompletion = COMPLETION_RE.test(text)
  const claimsRemaining = REMAINING_RE.test(text) && !/\bremaining:\s*(none|nothing|no\b)/i.test(text)
  const claimsBlocker = BLOCKER_RE.test(text)
  const claimsHandoff = HANDOFF_RE.test(text)
  const claimsUncertainty = UNCERTAINTY_RE.test(text)
  const claimsStatus = STATUS_WORD_RE.test(text)
  const claimsVerification = VERIFICATION_RE.test(text)
  const namesNextAction = NEXT_ACTION_RE.test(text)
  const namesOwner = OWNER_RE.test(text)
  const namesTimer = TIMER_RE.test(text)
  const namesAuthorityBoundary = BOUNDARY_RE.test(text)
  const namesProvenance = PROVENANCE_RE.test(text)
  const namesSuccessCriteria = SUCCESS_RE.test(text)

  return {
    claimsStatus,
    claimsCompletion,
    claimsRemaining,
    claimsBlocker,
    claimsHandoff,
    claimsUncertainty,
    claimsVerification,
    namesNextAction,
    namesOwner,
    namesTimer,
    namesAuthorityBoundary,
    namesProvenance,
    namesSuccessCriteria,
    skipLive: Boolean(context.skipLive),
    conversationMode: Boolean(context.conversationMode),
    activeTimer: Boolean(context.activeTimer),
    recentDelegation: Boolean(context.recentDelegation),
    recentMeaningfulWork: Boolean(context.recentMeaningfulWork),
    stableTrueBlocker: Boolean(context.stableTrueBlocker),
    repeatedSameState: Boolean(context.repeatedSameState),
  }
}

export function classifyDisclosureEvent(event = {}) {
  const features = extractDisclosureFeatures(event)

  if (features.skipLive || features.conversationMode) {
    return decision('suppress', 'mode-suppress', features, 0.95)
  }

  if (
    features.activeTimer ||
    features.recentDelegation ||
    features.recentMeaningfulWork ||
    features.stableTrueBlocker ||
    features.repeatedSameState
  ) {
    return decision('suppress', 'liveness-suppress', features, 0.88)
  }

  if (features.claimsCompletion && !features.claimsVerification) {
    return decision('intervene', 'completion-check', features, 0.82)
  }

  if (features.claimsHandoff && (!features.namesProvenance || !features.namesSuccessCriteria)) {
    return decision('intervene', 'handoff-check', features, 0.78)
  }

  if (features.claimsBlocker && !features.namesAuthorityBoundary && !features.namesNextAction) {
    return decision('intervene', 'blocker-check', features, 0.76)
  }

  if (
    features.claimsRemaining &&
    !features.namesNextAction &&
    !features.namesOwner &&
    !features.namesTimer &&
    !features.namesAuthorityBoundary
  ) {
    return decision('intervene', 'remaining-work-check', features, 0.74)
  }

  if (features.claimsUncertainty && !features.namesNextAction && !features.claimsVerification) {
    return decision('log_only', 'uncertainty-review', features, 0.58)
  }

  return decision('suppress', 'no-unmet-obligation', features, 0.7)
}

function decision(decision, reasonCode, features, confidence) {
  return {
    decision,
    reasonCode,
    confidence,
    features,
  }
}
