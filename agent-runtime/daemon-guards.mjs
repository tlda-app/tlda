import { readFileSync, unlinkSync } from 'node:fs'

// JSONL-watch debounce decision. The trailing debounce (clearTimeout + fresh
// timer on every fs.watch fire) defers the read until writes quiesce — so during
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
  throw new Error(`agent ${agentLabel} has no metadata.kind; refusing to infer a harness`)
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

export function harnessKindFromArgs(args = '') {
  const text = String(args || '')
  if (/(?:^|\s|[/\\])codex(?:\s|$)/.test(text)) return 'codex'
  if (/(?:^|\s|[/\\])goose(?:\s|$).*?\brun\b|\bgoose run\b/.test(text)) return 'goose'
  if (/(?:^|\s|[/\\])claude(?:\.exe)?(?:\s|$)/.test(text) && !text.includes('playwright')) return 'claude'
  return null
}

function compactMatch(match) {
  if (!match) return null
  return match.find((value, index) => index > 0 && value) || null
}

// Regex alternatives above use several capture positions for quoted/unquoted
// values. Normalize them after matching so callers never depend on which branch
// matched.
function normalizeFirstArgValue(args, patterns) {
  const text = String(args || '')
  for (const pattern of patterns) {
    const value = compactMatch(text.match(pattern))
    if (value) return value
  }
  return null
}

export function extractFleetProcessIdentity(args = '') {
  const text = String(args || '')
  return {
    fleetId: normalizeFirstArgValue(text, [
      /(?:^|\s)FLEET_ID=(?:'([^']+)'|"([^"]+)"|([^\s]+))/,
      /mcp_servers\.tlda\.env\.FLEET_ID=([^\s'"]+)/,
    ]),
    tmuxSession: normalizeFirstArgValue(text, [
      /(?:^|\s)FLEET_TMUX_SESSION=(?:'([^']+)'|"([^"]+)"|([^\s]+))/,
      /mcp_servers\.tlda\.env\.FLEET_TMUX_SESSION=([^\s'"]+)/,
    ]),
    resumeId: normalizeFirstArgValue(text, [
      /--resume\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))/,
      /\bcodex\s+resume\s+(?:'([^']+)'|"([^"]+)"|([^\s]+))/,
    ]),
  }
}

function agentSessionIds(agent) {
  const ids = []
  if (agent?.session_id) ids.push(agent.session_id)
  for (const sid of (agent?.session_ids || [])) {
    if (sid && !ids.includes(sid)) ids.push(sid)
  }
  return ids
}

function isBotAgent(agent) {
  const labels = Array.isArray(agent?.labels) ? agent.labels : []
  return labels.includes('bot') || !!agent?.metadata?.bot
}

export function matchAgentProcess(processInfo, agents = []) {
  const identity = extractFleetProcessIdentity(processInfo?.args || '')
  for (const agent of agents) {
    if (!agent || agent.human || isBotAgent(agent)) continue
    if (identity.fleetId && identity.fleetId === agent.id) return { agent, identity }
    if (identity.tmuxSession && identity.tmuxSession === agent.tmux_session) return { agent, identity }
    if (identity.resumeId && agentSessionIds(agent).includes(identity.resumeId)) return { agent, identity }
  }
  return { agent: null, identity }
}

export function selectOrphanAgentProcesses({
  processes = [],
  agents = [],
  liveTmuxSessions = new Set(),
  protectedPids = new Set(),
  minAgeMs = 60 * 60 * 1000,
} = {}) {
  const selected = []
  const skipped = []
  for (const proc of processes) {
    const harness = harnessKindFromArgs(proc?.args || '')
    if (!harness) {
      skipped.push({ ...proc, reason: 'not-agent-harness' })
      continue
    }
    if ((proc.ageMs || 0) < minAgeMs) {
      skipped.push({ ...proc, harness, reason: 'too-new' })
      continue
    }
    if (protectedPids.has(Number(proc.pid))) {
      skipped.push({ ...proc, harness, reason: 'live-pane-process' })
      continue
    }
    const { agent, identity } = matchAgentProcess(proc, agents)
    if (!agent) {
      skipped.push({ ...proc, harness, identity, reason: 'no-known-agent-match' })
      continue
    }
    if (agent.tmux_session && liveTmuxSessions.has(agent.tmux_session)) {
      skipped.push({ ...proc, harness, identity, agentId: agent.id, reason: 'agent-session-live' })
      continue
    }
    if (identity.tmuxSession && liveTmuxSessions.has(identity.tmuxSession)) {
      skipped.push({ ...proc, harness, identity, agentId: agent.id, reason: 'process-session-live' })
      continue
    }
    selected.push({
      ...proc,
      harness,
      identity,
      agentId: agent.id,
      agentName: agent.friendly_name || agent.name || agent.id,
      tmuxSession: identity.tmuxSession || agent.tmux_session || null,
    })
  }
  return { selected, skipped }
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

export function decideTerminalWatchExit({ paneLive } = {}) {
  return {
    terminalDead: paneLive === false,
    reason: paneLive === false ? 'pane-dead-or-missing' : paneLive === true ? 'watcher-exited-pane-live' : 'pane-liveness-unknown',
  }
}

const STARTUP_FAILURE_PATTERNS = [
  {
    code: 'codex-interactive-prompt',
    harness: 'codex',
    pattern: /(?:update available|new version available|press enter to (?:continue|confirm)|enter to continue|restart codex to update)/i,
  },
  {
    code: 'codex-interactive-prompt',
    harness: 'codex',
    pattern: /(?:do you trust the contents of this directory|trust this directory|approval required|allow command|press enter to confirm)/i,
  },
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
