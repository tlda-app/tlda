import { readFileSync, unlinkSync } from 'node:fs'

const warnedMissingKinds = new Set()

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

export function buildFleetSpawnArgs({
  name,
  model,
  kind,
  cwd,
  respawn,
  refresh,
  effort,
  mode,
  spawnPolicy,
} = {}) {
  const agentName = name || `agent-${Date.now().toString(36).slice(-4)}`
  const args = refresh ? ['--refresh', agentName] : (respawn ? [agentName] : ['--fresh', agentName])
  if (model) args.push('--model', model)
  if (kind) args.push('--kind', kind)
  if (effort) args.push('--effort', effort)
  if (mode) args.push('--mode', mode)
  if (spawnPolicy?.capability) args.push('--spawn-capability', spawnPolicy.capability)
  if (cwd) args.push('--cwd', cwd)
  args.push('--no-attach')
  return { agentName, args }
}
