#!/usr/bin/env node

import fs from 'node:fs'

const INTERVENE_REASONS = new Set([
  'completion-check',
  'remaining-work-check',
  'blocker-check',
  'handoff-check',
  'uncertainty-review',
])
const SUPPRESS_REASONS = new Set([
  'already-owned',
  'verified-status',
  'true-blocker',
  'live-conversation',
  'not-disclosure',
  'duplicate-or-contextless',
])
const LOG_ONLY_REASONS = new Set([
  'interesting-pattern',
  'needs-more-context',
])

function parseArgs(argv) {
  const args = { input: null, out: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--input') args.input = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--help' || arg === '-h') usage(0)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (!args.input) throw new Error('--input is required')
  if (!args.out) throw new Error('--out is required')
  return args
}

function usage(code) {
  console.log(`Usage: node bin/todd-disclosure-first-pass-labels.mjs --input review.jsonl --out labeled.jsonl`)
  process.exit(code)
}

function loadRows(path) {
  return fs.readFileSync(path, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

function adjudicate(row) {
  const text = row.text || ''
  const lower = text.toLowerCase()
  const f = row.features || {}

  const asksForApproval =
    /\b(your ok|your go-ahead|if you want me|deploy.*ok|restart.*ok|waiting on you|requires skip|permission|approve|your call)\b/i.test(text)
  const ownsNextAction =
    f.namesNextAction ||
    /\b(i('|’)ll|i will|i’m going to|i am going to|on it|back with|next i|i’ll keep|i won't|i will not|nothing deploys|nothing restarts)\b/i.test(text)
  const hasVerification =
    f.claimsVerification ||
    /\b(verified|tested|checked|passed|read the code|hard evidence|proven|surface)\b/i.test(text)
  const conversational =
    /^(right|yes|no|got it|understood|on it|fair|exactly|you're right|your instinct is right)\b/i.test(text.trim())
  const trueExternalBlocker =
    asksForApproval ||
    /\b(provider credits|disk is .*full|fly.*502|live deploy|restart the live|authority|external)\b/i.test(text)

  if (conversational && ownsNextAction) {
    return label('suppress', 'already-owned', 'Conversational reply names its next action or boundary.')
  }

  if (trueExternalBlocker) {
    return label('suppress', 'true-blocker', 'Names a user/runtime/external boundary rather than an agent self-check failure.')
  }

  if (f.claimsCompletion && hasVerification && !f.claimsHandoff && !f.claimsRemaining) {
    return label('suppress', 'verified-status', 'Completion/status claim includes verification evidence.')
  }

  if (f.claimsCompletion && !hasVerification) {
    return label('intervene', 'completion-check', 'Claims completion without adequate verification evidence.')
  }

  if (f.claimsHandoff && (!f.namesProvenance || !f.namesSuccessCriteria)) {
    return label('intervene', 'handoff-check', 'Handoff lacks provenance or success criteria.')
  }

  if (f.claimsBlocker && !trueExternalBlocker && !ownsNextAction) {
    return label('intervene', 'blocker-check', 'Blocker language without a true boundary or next diagnostic action.')
  }

  if (f.claimsRemaining && !ownsNextAction && !f.namesOwner && !f.namesTimer && !trueExternalBlocker) {
    return label('intervene', 'remaining-work-check', 'Remaining-work language lacks owner, timer, or next action.')
  }

  if (f.claimsUncertainty && !ownsNextAction && !hasVerification) {
    return label('log_only', 'interesting-pattern', 'Uncertainty is useful evidence but not clearly interrupt-worthy.')
  }

  if (ownsNextAction || f.namesOwner || f.namesTimer) {
    return label('suppress', 'already-owned', 'Row names an owner, timer, or next action.')
  }

  return label('suppress', 'not-disclosure', 'High-recall candidate but not an actionable Todd intervention.')
}

function label(humanLabel, humanReasonCode, humanNotes) {
  return { humanLabel, humanReasonCode, humanNotes }
}

function validate(row) {
  if (row.humanLabel === 'intervene' && !INTERVENE_REASONS.has(row.humanReasonCode)) return false
  if (row.humanLabel === 'suppress' && !SUPPRESS_REASONS.has(row.humanReasonCode)) return false
  if (row.humanLabel === 'log_only' && !LOG_ONLY_REASONS.has(row.humanReasonCode)) return false
  return true
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const rows = loadRows(args.input).map(row => {
    const adjudication = adjudicate(row)
    const output = { ...row, ...adjudication, labelSource: 'codex-first-pass-policy-2026-06-25' }
    if (!validate(output)) throw new Error(`invalid label for event ${row.eventId}`)
    return output
  })
  fs.writeFileSync(args.out, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  const counts = {}
  for (const row of rows) {
    const key = `${row.humanLabel} / ${row.humanReasonCode}`
    counts[key] = (counts[key] || 0) + 1
  }
  console.error(JSON.stringify({ rows: rows.length, counts }, null, 2))
}

main()
