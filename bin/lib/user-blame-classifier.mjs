const USER_FAULT_RE = /\b(?:you|your)\b/i
const USER_ACTION_RE = /\b(?:you\s+(?:(?:didn't|did not|haven't|have not)\s+(?:accept|open|use|hit|click|send|log in|configure)|need to|needed to|just need to|need|needed|should|must|have to|hit|opened|used|clicked|accepted|sent|went to|logged in|configured)|your\s+(?:end|machine|browser|device|network|session|cache|token|url|server|port|certificate|cert))\b/i
const USER_CAUSAL_CONNECTIVE_RE = /\b(?:because|since|the reason\b[\s\S]{0,60}\bis|that'?s why|that is why|now that|unless|as long as|until|before)\s+you\b/i
const USER_NEGATIVE_ACTION_RE = /\byou\s+(?:didn'?t|did not|haven'?t|have not|never|forgot to|failed to|need to|should have|aren'?t)\b/i
const USER_DEFLECTION_LOCUS_RE = /\bon your\s+(?:end|side|machine|laptop|browser|device|phone|ipad)\b/i
const USER_ACTION_CONSEQUENCE_RE = /\byou\s+\w+ed\b[\s\S]{0,100}\b(?:that'?s why|that is why|so it|which is why|and now)\b/i
const USER_FAULT_GRAMMAR_RE = new RegExp(`(?:${USER_CAUSAL_CONNECTIVE_RE.source}|${USER_NEGATIVE_ACTION_RE.source}|${USER_DEFLECTION_LOCUS_RE.source}|${USER_ACTION_CONSEQUENCE_RE.source})`, 'i')
const FAILURE_FRAME_RE = /\b(?:gone|breaks?|broken|failed|fails?|failing|error|issue|problem|missing|nothing (?:shows up|renders|appears)|not (?:seeing|showing|rendering|appearing|working|loading)|doesn'?t (?:show|render|appear|work|load)|won'?t (?:show|render|appear|work|load|\w+)|will not (?:show|render|appear|work|load)|can'?t|cannot|won'?t|doesn'?t|no output|empty|blank|stuck)\b/i
const ACTION_BREAKAGE_RE = new RegExp(`${USER_ACTION_CONSEQUENCE_RE.source}[\\s\\S]{0,100}${FAILURE_FRAME_RE.source}|${FAILURE_FRAME_RE.source}[\\s\\S]{0,100}${USER_ACTION_CONSEQUENCE_RE.source}`, 'i')
const OWN_SYSTEM_RE = /\b(?:tlda|fleet|fleet daemon|daemon|server|viewer|iPad|your setup|your system|your own system|the app|your (?:annotations|agents|daemon|server|fleet|sessions|setup|notes|docs))\b/i
const LECTURE_RE = /\b(?:remember,?|just so you understand,?|to explain,?|to explain your own system|fyi,?\s+the way|the way (?:this|tlda|fleet|the app|your setup|your system) works is|what(?:'s| is) happening is|this is how (?:tlda|fleet|the app|your setup|your system) works|remember that (?:tlda|fleet|the app|your setup|your system)|you need to understand)\b/i
const SELF_VERIFICATION_RE = /\b(?:I\s+(?:verified|tested|checked)\b|verified\s+from\s+the\s+Mini|works?\s+(?:on|from)\s+(?:my\s+)?(?:machine|end|browser|side|setup|Mini)|I\s+verified\s+it\s+works\s+from\s+the\s+Mini)\b/i
const USER_DEFLECTION_RE = /\b(?:your\s+(?:end|machine|browser|device|side|setup|cache|token|cert(?:ificate)?)|for\s+you|local\s+to\s+you|on\s+your\s+(?:end|machine|browser|device|side|setup)|should\s+be\s+fine\s+(?:for\s+you|on\s+your\s+end)|must\s+be\s+local\s+to\s+you)\b/i
const WRONG_SURFACE_RE = new RegExp(`(?:${SELF_VERIFICATION_RE.source}[\\s\\S]{0,120}${USER_DEFLECTION_RE.source}|${USER_DEFLECTION_RE.source}[\\s\\S]{0,120}${SELF_VERIFICATION_RE.source})`, 'i')
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
    ['user-fault-framing', USER_FAULT_GRAMMAR_RE],
    ['user-fault-framing', USER_ACTION_RE],
  ])

  const hasUserFaultLanguage = USER_FAULT_RE.test(candidateText) && (
    ACTION_BREAKAGE_RE.test(candidateText) ||
    (USER_FAULT_GRAMMAR_RE.test(candidateText) && FAILURE_FRAME_RE.test(candidateText)) ||
    USER_ACTION_RE.test(candidateText)
  )
  const lecturesUserSystem = LECTURE_RE.test(candidateText) && OWN_SYSTEM_RE.test(candidateText)
  const paradesWrongSurface = WRONG_SURFACE_RE.test(candidateText)
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
