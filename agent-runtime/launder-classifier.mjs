const MATH_SYMBOL_RE = String.raw`(?:\\[A-Za-z]+(?:\s*\{[^}]{1,20}\})?(?:\s+(?:\p{Lu}|[a-z]|[\u0391-\u03ff])[\p{L}\u0300-\u036f]*(?:[_^][A-Za-z0-9{}\\]+)?)?(?:\s*\([^)]{0,20}\))?|\p{Lu}[\p{L}\u0300-\u036f]*(?:[_^][A-Za-z0-9{}\\]+)?(?:\s*\([^)]{0,20}\))?|[a-z](?:[_^][A-Za-z0-9{}\\]+)?(?:\s*\([^)]{0,20}\))?|[\u0391-\u03ff][\p{L}\u0300-\u036f]*(?:[_^][A-Za-z0-9{}\\]+)?(?:\s*\([^)]{0,20}\))?)`
const CONTENT_WORD_RE = String.raw`(?!(?:the|a|an|as|for|to|be|is|are|and|or|of|in|on|with)\b)[a-z]+(?:-[a-z]+)*`
const MATH_HEAD_NOUN_RE = String.raw`(?:term|factor|ratio|function|deficit|weight|estimate|surrogate|bound|statistic|coefficient|operator|measure|norm|envelope|remainder|residual|partition|curvature|slack|profile|score|ledger)`
const TERM_OBJECT_RE = String.raw`${CONTENT_WORD_RE}(?:\s+${CONTENT_WORD_RE}){0,4}\s+${MATH_HEAD_NOUN_RE}\b`
const MATH_BIND_RE = new RegExp(String.raw`\b(?:(?:[Ll]et|[Dd]efine|[Ss]et)\s+(${MATH_SYMBOL_RE})\s+(?:[Dd]enote|[Ff]or|[Aa]s|[Tt]o be|[Bb]e|=|:=)|(?:[Ww]e\s+)?(?:[Ww]rite|[Dd]enote)\s+(${MATH_SYMBOL_RE})\s+(?:[Ff]or|[Aa]s|[Tt]o be)|[Dd]enote\s+by\s+(${MATH_SYMBOL_RE})(?=\s|[.,;:)]|$)|(${MATH_SYMBOL_RE})\s*:=)`, 'u')
const COINED_TERM_RE = new RegExp(String.raw`\b(?:(?:[Ll]et|[Dd]efine|[Ss]et)\s+(?:the\s+)?(${TERM_OBJECT_RE})\s+(?:[Dd]enote|[Ff]or|[Aa]s|[Tt]o be|[Bb]e|=|:=)|(?:[Ww]e\s+)?(?:[Ww]rite|[Dd]enote)\s+(?:the\s+)?(${TERM_OBJECT_RE})\s+(?:[Ff]or|[Aa]s|[Tt]o be)|(?:[Cc]all|[Nn]ame|[Ii]ntroduce)\s+(?:(?:this|that|it)\s+)?(?:the\s+)?(${TERM_OBJECT_RE})\b)`, 'u')
const GROUNDING_RE = /\b(?:notation (?:I'?m|I am) introducing|new shorthand|new notation|shorthand for|for readability|not in the paper|not Skip'?s notation|paper'?s notation|as in the paper|from the paper|paper uses|I'?ll use .*? as shorthand|I will use .*? as shorthand)\b/i
const REPO_CONTEXT_RE = /\b(?:repo|code path|handler|route|class|method|typescript|javascript|mcp-server|fleet-tools)\b/i
const PAPER_CONTEXT_RE = /\b(?:paper'?s|in the paper|as written|existing notation|standing notation|Skip'?s notation)\b/i

export function isLaunderCandidate(text = '') {
  const candidateText = lintableText(text)
  return MATH_BIND_RE.test(candidateText) || COINED_TERM_RE.test(candidateText)
}

export function extractLaunderFeatures(event = {}) {
  const text = event.text || ''
  const context = event.context || {}
  const candidateText = lintableText(text)
  const matched = firstMatch(candidateText, [
    ['ungrounded-notation-introduction', MATH_BIND_RE],
    ['ungrounded-notation-introduction', COINED_TERM_RE],
  ])
  const matchedSpan = matched?.span || null
  const hasGrounding = GROUNDING_RE.test(candidateText)
  const repoContext = REPO_CONTEXT_RE.test(candidateText)
  const paperGrounding = PAPER_CONTEXT_RE.test(candidateText)
  const quotedMatch = Boolean(matched && isSpanQuoted(candidateText, matched.index, matched.index + matched.span.length))
  const strongIntroduction = Boolean(matched && matched.reasonCode === 'ungrounded-notation-introduction')
  const weakNovelTerm = Boolean(matched && matched.reasonCode === 'weak-novel-term')

  return {
    toSkip: Boolean(context.toSkip),
    paperContext: Boolean(context.paperContext),
    matchedSpan,
    matchedReasonCode: matched?.reasonCode || null,
    hasGrounding,
    repoContext,
    paperGrounding,
    quotedMatch,
    strongIntroduction,
    weakNovelTerm,
  }
}

export function classifyLaunder(event = {}) {
  const features = extractLaunderFeatures(event)

  if (!features.toSkip) return decision('clean', 'not-skip-recipient', features, 0.96)
  if (!features.paperContext) return decision('clean', 'not-paper-context', features, 0.96)

  if (!features.matchedSpan) return decision('clean', 'no-notation-introduction', features, 0.74)

  if (features.quotedMatch || features.repoContext || features.paperGrounding || features.hasGrounding) {
    return decision('clean', 'grounded-or-quoted', features, 0.9)
  }

  if (features.strongIntroduction) {
    return decision('flag', 'ungrounded-notation-introduction', features, 0.84)
  }

  return decision('clean', 'no-notation-introduction', features, 0.7)
}

function lintableText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, match => ' '.repeat(match.length))
    .split('\n')
    .map(line => (/^\s*>/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n')
}

function firstMatch(text, entries) {
  for (const [reasonCode, re] of entries) {
    re.lastIndex = 0
    const match = re.exec(text)
    if (match) return { reasonCode, span: match[0], index: match.index }
  }
  return null
}

function isSpanQuoted(text, start, end) {
  return quoteRanges(text).some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd)
}

function quoteRanges(text) {
  const ranges = []
  for (const re of [/```[\s\S]*?```/g, /`[^`]*`/g, /"[^"]*"/g, /'[^']*'/g]) {
    for (const match of String(text).matchAll(re)) ranges.push([match.index, match.index + match[0].length])
  }
  return ranges
}

function decision(decision, reasonCode, features, confidence) {
  return {
    decision,
    reasonCode,
    confidence,
    features,
  }
}
