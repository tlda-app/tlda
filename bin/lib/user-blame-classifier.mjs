const USER_FAULT_RE = /\b(?:you|your)\b/i
const USER_ACTION_RE = /\b(?:you\s+(?:need to|needed to|just need to|need|needed|should|must|have to|hit|opened|used|clicked|accepted|sent|went to|logged in|configured)|your\s+(?:end|machine|browser|device|network|session|cache|token|url|server|port|certificate|cert))\b/i
const FAILURE_SURFACE_RE = /\b(?:wrong|invalid|missing|expired|stale|broken|failed|failing|can't|cannot|won't|doesn't|not|cert(?:ificate)?|token|url|server|port|browser|device|machine|prompt|localhost|https?|cache|auth)\b/i
const LECTURE_RE = /\b(?:the way (?:tlda|fleet|the app|your setup|your system) works is|what(?:'s| is) happening is|this is how (?:tlda|fleet|the app|your setup|your system) works|remember that (?:tlda|fleet|the app|your setup|your system)|you need to understand)\b/i
const WRONG_SURFACE_RE = /\b(?:I\s+(?:verified|tested|checked)\s+(?:it\s+)?(?:myself\s+)?(?:on|from)\s+my\s+(?:machine|end|browser|side|setup)|works?\s+(?:on|from)\s+my\s+(?:machine|end|browser|side|setup)|verified\s+from\s+the\s+Mini)\b/i
const USER_REPORTED_FAILURE_RE = /\b(?:you\s+(?:said|reported|saw|are seeing|were seeing)|on\s+your\s+(?:device|machine|browser|end|side)|failed\s+for\s+you|it\s+failed\s+there)\b/i
const AGREEMENT_RE = /^(?:yes|right|agreed|exactly|got it|understood|fair)\b/i
const OWNERSHIP_RE = /\b(?:that's mine|that is mine|my bug|my mistake|I need to fix|I'll fix|I will fix|I'm fixing|I am fixing|I need to test|I should have tested|I didn't test|I did not test)\b/i
const REPO_EXPLANATION_RE = /\b(?:the repo(?:'s)?|this function|this module|the code path|the implementation|the server route|the handler)\b/i
const DIAGNOSTIC_QUOTE_RE = /\b(?:log|error|output|trace|stack|console|message)\s+(?:says|shows|contains|included|reported)\b/i

export function isUserBlameCandidate(text = '') {
  const candidateText = lintableText(text)
  return (
    USER_FAULT_RE.test(candidateText) ||
    LECTURE_RE.test(candidateText) ||
    WRONG_SURFACE_RE.test(candidateText)
  )
}

export function extractUserBlameFeatures(event = {}) {
  const text = event.text || ''
  const context = event.context || {}
  const candidateText = lintableText(text)
  const matched = firstMatch(candidateText, [
    ['wrong-surface-verification', WRONG_SURFACE_RE],
    ['lecturing-user-system', LECTURE_RE],
    ['user-fault-framing', USER_ACTION_RE],
  ])

  const hasUserFaultLanguage = USER_FAULT_RE.test(candidateText) && USER_ACTION_RE.test(candidateText) && FAILURE_SURFACE_RE.test(candidateText)
  const lecturesUserSystem = LECTURE_RE.test(candidateText)
  const paradesWrongSurface = WRONG_SURFACE_RE.test(candidateText) && (USER_REPORTED_FAILURE_RE.test(candidateText) || FAILURE_SURFACE_RE.test(candidateText))
  const agreesWithSkip = AGREEMENT_RE.test(candidateText.trim())
  const ownsFix = OWNERSHIP_RE.test(candidateText)
  const explainsRepoCode = REPO_EXPLANATION_RE.test(candidateText)
  const quotesDiagnostic = DIAGNOSTIC_QUOTE_RE.test(text) && quotedOrCodeText(text).some(chunk => /(?:you|your)/i.test(chunk))

  return {
    toSkip: Boolean(context.toSkip),
    hasUserFaultLanguage,
    lecturesUserSystem,
    paradesWrongSurface,
    agreesWithSkip,
    ownsFix,
    explainsRepoCode,
    quotesDiagnostic,
    matchedReasonCode: matched?.reasonCode || null,
    matchedSpan: matched?.span || null,
  }
}

export function classifyUserBlame(event = {}) {
  const features = extractUserBlameFeatures(event)

  if (!features.toSkip) return decision('clean', 'not-skip-recipient', features, 0.96)

  if (features.quotesDiagnostic || features.explainsRepoCode || (features.agreesWithSkip && features.ownsFix)) {
    return decision('clean', 'hard-negative-context', features, 0.9)
  }

  if (features.lecturesUserSystem) {
    return decision('flag', 'lecturing-user-system', features, 0.86)
  }

  if (features.paradesWrongSurface && !features.ownsFix) {
    return decision('flag', 'wrong-surface-verification', features, 0.82)
  }

  if (features.hasUserFaultLanguage && !features.ownsFix) {
    return decision('flag', 'user-fault-framing', features, 0.84)
  }

  if (features.hasUserFaultLanguage || features.paradesWrongSurface) {
    return decision('log_only', 'weak-user-blame-signal', features, 0.58)
  }

  return decision('clean', 'no-user-blame', features, 0.72)
}

function lintableText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter(line => !/^\s*>/.test(line))
    .join('\n')
}

function quotedOrCodeText(text) {
  const chunks = []
  for (const match of String(text).matchAll(/```([\s\S]*?)```/g)) chunks.push(match[1])
  for (const match of String(text).matchAll(/"([^"]+)"/g)) chunks.push(match[1])
  for (const match of String(text).matchAll(/`([^`]+)`/g)) chunks.push(match[1])
  return chunks
}

function firstMatch(text, entries) {
  for (const [reasonCode, re] of entries) {
    const match = re.exec(text)
    if (match) return { reasonCode, span: match[0] }
  }
  return null
}

function decision(decision, reasonCode, features, confidence) {
  return {
    decision,
    reasonCode,
    confidence,
    features,
  }
}
