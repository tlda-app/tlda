const REMAINING_WORK_RE = /\b(?:remaining|still needs?|needs? to|not verified|not deployed|would require|unless)\b/i
const NO_REMAINING_WORK_RE = /\b(?:remaining|next)\s*:\s*(?:none|nothing|no(?:ne)?|n\/?a)\b/i
const AUTHORITY_BOUNDARY_RE = /\b(?:authority boundary|requires Skip|waiting for Skip|external blocker|waiting on an external|permission(?: is)? required|user lock)\b/i
const CONTINUED_OWNER_RE = /\b(?:owner|assigned to|delegated to)\s*[:=]?\s*(?!someone\b|another agent\b|next agent\b|tbd\b|later\b)[a-z0-9][a-z0-9:_-]*/i
const CONTINUED_TASK_RE = /\b(?:continued )?task(?: id)?\s*[:=]\s*[a-z0-9][a-z0-9:_-]*/i

/**
 * A close request is not a license to discard work the report itself says is
 * still owned. Todd's live-conversation nudge is intentionally advisory; this
 * guard is used by the durable report-close path where task state changes.
 */
export function decideReportClose(summary = '') {
  const text = String(summary)
  const admitsRemainingWork = REMAINING_WORK_RE.test(text) && !NO_REMAINING_WORK_RE.test(text)

  if (!admitsRemainingWork) return { allowClose: true, reason: 'no-remaining-work' }
  if (AUTHORITY_BOUNDARY_RE.test(text)) return { allowClose: true, reason: 'authority-boundary' }
  if (CONTINUED_OWNER_RE.test(text) || CONTINUED_TASK_RE.test(text)) {
    return { allowClose: true, reason: 'continued-owner-or-task' }
  }

  return {
    allowClose: false,
    reason: 'remaining-owned-work',
    message: 'Report identifies remaining work without a concrete continued owner/task or true authority boundary. The report was recorded and the task remains open.',
  }
}
