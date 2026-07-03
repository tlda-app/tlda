import { readFileSync, unlinkSync } from 'node:fs'

const warnedMissingKinds = new Set()

// JSONL-watch debounce decision. The trailing debounce (clearTimeout + fresh
// timer on every file-watch event) defers the read until writes quiesce — so during
// a continuous sub-debounce write burst the read never fires and chat activity
// lags the whole burst. This adds a max-wait cap: once the first *unread* write
// is older than maxWaitMs, flush immediately instead of resetting the timer.
// `firstPendingAt` is the timestamp the debounce started from idle (null when no
// read is pending). Pure so the daemon's burst-starvation guard is unit-testable.
export function shouldFlushWatch(firstPendingAt, now, maxWaitMs = 150) {
  return firstPendingAt != null && (now - firstPendingAt) >= maxWaitMs
}

export function harnessKindForAgent(agent, log = console) {
  const kind = agent?.metadata?.kind
  if (kind) return kind
  const agentLabel = agent?.friendly_name || agent?.id || '<unknown>'
  if (!warnedMissingKinds.has(agentLabel)) {
    warnedMissingKinds.add(agentLabel)
    log?.warn?.(`agent ${agentLabel} has no metadata.kind; defaulting to claude`)
  }
  return 'claude'
}

export function unlinkPidfileIfOwnPid(pidFile, pid = process.pid) {
  let content
  try {
    content = readFileSync(pidFile, 'utf8').trim()
  } catch {
    return false
  }
  if (content !== String(pid)) return false
  try {
    unlinkSync(pidFile)
    return true
  } catch {
    return false
  }
}

export function isPlaywrightBrowserArgs(args = '') {
  if (!args) return false
  if (args.includes('playwright_chromiumdev_profile')) return true
  if (!args.includes('ms-playwright')) return false

  // `ms-playwright` can appear in non-browser argv too, e.g. Codex launched with
  // `--add-dir ~/Library/Caches/ms-playwright`. Only classify actual browser
  // executables from the Playwright cache, not arbitrary tools granted access to
  // that directory.
  return /ms-playwright.*(?:\/(?:chrome|chromium|headless_shell)(?:\s|$)|\/Chromium\.app\/Contents\/MacOS\/Chromium(?:\s|$)|\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome(?:\s|$))/i.test(args)
}

export function codexKnownRolloutIds(agent) {
  const ids = []
  if (agent?.session_id) ids.push(agent.session_id)
  for (const sid of (agent?.session_ids || [])) {
    if (sid && !ids.includes(sid)) ids.push(sid)
  }
  return ids
}

export function codexPathMatchesKnownRollout(jsonlPath, agent) {
  const ids = codexKnownRolloutIds(agent)
  return ids.length > 0 && ids.some(id => jsonlPath.endsWith(`-${id}.jsonl`))
}

export function shouldClaimCodexWatcher({
  currentPrimaryId,
  agent,
  jsonlPath,
  rolloutHasOwnerEvidence = null,
  rolloutBelongsToAgent = null,
} = {}) {
  if (currentPrimaryId === agent?.id) return true
  if (!codexPathMatchesKnownRollout(jsonlPath || '', agent)) return false

  // A rollout id match proves the stored handle points at this file, but not
  // that the handle still belongs to this fleet row. If the rollout itself
  // contains fleet ownership evidence, require it to match before allowing a
  // watcher takeover; stale session_ids must not steal another live agent's
  // activity cards.
  if (rolloutHasOwnerEvidence?.(jsonlPath)) {
    return !!rolloutBelongsToAgent?.(jsonlPath, agent)
  }
  return true
}

export function claudeSessionBelongsToAgent(owners = [], agent) {
  return !!agent?.id && owners.includes(agent.id)
}

export function shouldClaimClaudeWatcher({
  agent,
  owners = [],
} = {}) {
  return claudeSessionBelongsToAgent(owners, agent)
}

export function decideMissingLiveness({
  now,
  missingSince,
  graceMs,
  alreadyHibernating = false,
} = {}) {
  if (alreadyHibernating) return { alive: false, hibernate: true, since: missingSince || now }
  const since = missingSince || now
  if ((now - since) < graceMs) return { alive: true, hibernate: false, since }
  return { alive: false, hibernate: true, since }
}

const STARTUP_FAILURE_PATTERNS = [
  {
    code: 'codex-unsupported-model',
    harness: 'codex',
    pattern: /(?:unsupported|unknown|invalid)\s+model|model\s+[`"']?gpt-5[`"']?\s+(?:is\s+)?(?:not\s+)?(?:supported|available)|model_not_found/i,
  },
  {
    code: 'goose-startup-error',
    harness: 'goose',
    pattern: /(?:unknown|unsupported|invalid)\s+(?:provider|model|recipe)|provider .*not found|failed to (?:initialize|load).*provider|goose.*(?:error|failed)/i,
  },
  {
    code: 'account-auth-startup-error',
    harness: null,
    pattern: /(?:not logged in|authentication required|invalid api key|missing api key|account .*required|subscription .*required|permission denied|HTTP CONNECT 403|status code:?\s*40[13])/i,
  },
]

export function detectSpawnStartupFailureTranscript(text = '', { harness = null } = {}) {
  const normalized = String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
  if (!normalized.trim()) return null
  const lines = normalized.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const snippet = lines.slice(-12).join('\n').slice(-2000)
  const wantedHarness = harness ? String(harness).toLowerCase() : null
  for (const rule of STARTUP_FAILURE_PATTERNS) {
    if (rule.harness && wantedHarness && rule.harness !== wantedHarness) continue
    if (!rule.pattern.test(normalized)) continue
    const line = [...lines].reverse().find(l => rule.pattern.test(l)) || lines[lines.length - 1] || 'startup failed'
    return {
      code: rule.code,
      reason: line.slice(0, 500),
      snippet,
    }
  }
  return null
}
