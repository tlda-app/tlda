import { execFile } from 'child_process'
import { promisify } from 'util'
import { decideMissingLiveness } from '../agent-runtime/daemon-guards.mjs'

const execFileP = promisify(execFile)

function paneSubtreeHasAgent(panePid, childrenByPpid, agentProcPids) {
  const stack = [panePid]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    if (agentProcPids.has(pid)) return true
    const kids = childrenByPpid.get(pid)
    if (kids) for (const kid of kids) stack.push(kid)
  }
  return false
}

export function createAgentLiveness({
  tmuxArgs,
  log,
  sendMsg,
  getAgents,
  harnessAdapters,
  listSessions,
  agentStatus,
  jsonlIngestor,
  isConnected,
  gooseKickSweep,
  deathCheckMs = 30_000,
  activityFreshMs = 90_000,
  hibernateGraceMs = Number(process.env.TLDA_HIBERNATE_GRACE_MS || 120_000),
}) {
  const TMUX_ARGS = tmuxArgs || []
  const alivenessCache = new Map()
  const missingSessionSince = new Map()
  const missingRuntimeSince = new Map()
  const observedLiveSessions = new Set()
  const observedLiveRuntimes = new Set()
  let deathCheckInterval = null
  let lastLivenessDisconnectWarnAt = 0

  function clearTransientMissingState() {
    missingSessionSince.clear()
    missingRuntimeSince.clear()
  }

  function noteActivity(agentId) {
    const agent = getAgents().find(a => a.id === agentId)
    if (!agent?.tmux_session) return
    alivenessCache.set(agent.tmux_session, true)
    missingSessionSince.delete(agentId)
    agent.last_seen = new Date().toISOString()
  }

  async function check() {
    return // KILL-SWITCH (Skip 2026-07-06): hibernation/liveness sweep disabled so agents are never marked hibernating. Revert this line to re-enable.
    const agents = getAgents()
    if (!agents.length) return
    if (!isConnected()) {
      clearTransientMissingState()
      const now = Date.now()
      if (now - lastLivenessDisconnectWarnAt > 30_000) {
        log.warn('skipping agent liveness check while daemon websocket is not ready')
        lastLivenessDisconnectWarnAt = now
      }
      return
    }

    const now = Date.now()
    const aliveAgentIds = []
    const checkedAgentIds = []
    let sessions
    try {
      const result = await listSessions()
      sessions = new Set(result.sessions || [])
    } catch (e) {
      log.warn(`tmux session probe failed during liveness check - preserving prior liveness: ${e.message}`)
      return
    }

    const agentsBySession = new Map()
    for (const agent of agents) {
      if (agent.dead || agent.human || !agent.tmux_session) continue
      if (!agentsBySession.has(agent.tmux_session)) agentsBySession.set(agent.tmux_session, [])
      agentsBySession.get(agent.tmux_session).push(agent)
    }

    for (const session of [...observedLiveSessions]) {
      if (sessions.has(session)) continue
      for (const agent of (agentsBySession.get(session) || [])) {
        checkedAgentIds.push(agent.id)
        const decision = decideMissingLiveness({
          now,
          missingSince: missingSessionSince.get(agent.id),
          graceMs: hibernateGraceMs,
          alreadyHibernating: agent.hibernating,
        })
        missingSessionSince.set(agent.id, decision.since)
        if (decision.alive) {
          alivenessCache.set(session, true)
          aliveAgentIds.push(agent.id)
          continue
        }
        if (!agent.hibernating) {
          log.info(`agent ${agent.friendly_name || agent.id} is hibernating (tmux session ${session} gone for ${Math.round((now - decision.since) / 1000)}s)`)
        }
        agent.hibernating = true
        agentStatus.emitAgentStatus(agent.id, 'hibernating')
        alivenessCache.set(session, false)
      }
      observedLiveSessions.delete(session)
    }

    const candidateAgents = []
    for (const session of sessions) {
      for (const agent of (agentsBySession.get(session) || [])) {
        checkedAgentIds.push(agent.id)
        observedLiveSessions.add(agent.tmux_session)
        missingSessionSince.delete(agent.id)
        const lastSeenMs = Date.parse(agent.last_seen || '') || 0
        if (now - lastSeenMs < activityFreshMs) {
          alivenessCache.set(agent.tmux_session, true)
          aliveAgentIds.push(agent.id)
          continue
        }
        candidateAgents.push(agent)
      }
    }

    if (!candidateAgents.length) {
      sendMsg({ type: 'agent-liveness', agent_ids: aliveAgentIds, checked_agent_ids: checkedAgentIds })
      return
    }

    const sessionToPanes = new Map()
    try {
      const { stdout } = await execFileP('tmux',
        [...TMUX_ARGS, 'list-panes', '-a', '-F', '#{session_name} #{pane_pid}'],
        { timeout: 5000, encoding: 'utf8' })
      for (const line of stdout.trim().split('\n')) {
        const sp = line.indexOf(' ')
        if (sp < 0) continue
        const sess = line.slice(0, sp)
        const pid = line.slice(sp + 1)
        if (!sessionToPanes.has(sess)) sessionToPanes.set(sess, [])
        sessionToPanes.get(sess).push(pid)
      }
    } catch {}

    const runtimePidsByKind = new Map(
      Object.keys(harnessAdapters).map(kind => [kind, new Set()])
    )
    const childrenByPpid = new Map()
    try {
      const { stdout } = await execFileP('ps', ['-eo', 'pid,ppid,args'],
        { timeout: 5000, encoding: 'utf8' })
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s/)
        if (match) {
          const pid = match[1]
          const ppid = match[2]
          if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
          childrenByPpid.get(ppid).push(pid)
        }
        const pid = line.trim().split(/\s+/)[0]
        if (!pid) continue
        for (const adapter of Object.values(harnessAdapters)) {
          if (adapter.processRe.test(line)) {
            runtimePidsByKind.get(adapter.kind)?.add(pid)
          }
        }
      }
    } catch (e) {
      log.warn(`ps failed during death detection - skipping cycle: ${e.message}`)
      return
    }

    let watcherNeedsSync = false
    for (const agent of candidateAgents) {
      const panes = sessionToPanes.get(agent.tmux_session) || []
      const claimed = agent?.metadata?.kind
      let matchedKind = null
      if (claimed && runtimePidsByKind.has(claimed) &&
          panes.some(pid => paneSubtreeHasAgent(pid, childrenByPpid, runtimePidsByKind.get(claimed)))) {
        matchedKind = claimed
      } else {
        for (const [kind, pids] of runtimePidsByKind) {
          if (panes.some(pid => paneSubtreeHasAgent(pid, childrenByPpid, pids))) {
            matchedKind = kind
            break
          }
        }
      }

      const agentAlive = matchedKind !== null
      const priorRuntimeKind = agent.runtimeKind
      agent.runtimeKind = matchedKind || (runtimePidsByKind.has(claimed) ? claimed : 'claude')
      if (matchedKind && priorRuntimeKind && priorRuntimeKind !== matchedKind) watcherNeedsSync = true

      alivenessCache.set(agent.tmux_session, agentAlive)

      if (!agentAlive) {
        const decision = decideMissingLiveness({
          now,
          missingSince: missingRuntimeSince.get(agent.id),
          graceMs: 0,
          alreadyHibernating: agent.hibernating,
        })
        missingRuntimeSince.set(agent.id, decision.since)
        if (decision.alive) {
          if (!observedLiveRuntimes.has(agent.id)) {
            log.info(`preserving awake status for ${agent.friendly_name || agent.id}: no agent process in session ${agent.tmux_session} on first local observation, within grace`)
          }
          alivenessCache.set(agent.tmux_session, true)
          aliveAgentIds.push(agent.id)
          continue
        }
        if (!agent.hibernating) {
          log.info(`agent ${agent.friendly_name || agent.id} is hibernating (no agent process in session ${agent.tmux_session} for ${Math.round((now - decision.since) / 1000)}s)`)
          try {
            const { stdout: lastLines } = await execFileP('tmux',
              [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', '-15'],
              { timeout: 3000, encoding: 'utf8' })
            const trimmed = lastLines.trim()
            if (trimmed) {
              sendMsg({
                type: 'agent-crash',
                agent_id: agent.id,
                agent_name: agent.friendly_name || agent.id,
                tmux_session: agent.tmux_session,
                last_output: trimmed,
              })
            }
          } catch {}
        }
        agent.hibernating = true
        agentStatus.emitAgentStatus(agent.id, 'hibernating')
        alivenessCache.set(agent.tmux_session, false)
        continue
      }

      observedLiveRuntimes.add(agent.id)
      missingRuntimeSince.delete(agent.id)

      if (agent.hibernating) {
        log.info(`agent ${agent.friendly_name || agent.id} is present`)
        agent.hibernating = false
        agentStatus.emitAgentStatus(agent.id, 'present')
        agentStatus.armAgent(agent.id)
        watcherNeedsSync = true
      }
      if (matchedKind && matchedKind !== 'claude') {
        if (!jsonlIngestor.hasWatcherForAgent(agent, matchedKind)) {
          watcherNeedsSync = true
        }
      }
      aliveAgentIds.push(agent.id)
    }

    if (watcherNeedsSync) {
      void jsonlIngestor.sync(agents).catch(e => log.error(`syncSessionWatchers failed: ${e.stack || e.message}`))
    }

    await gooseKickSweep(candidateAgents)
    sendMsg({ type: 'agent-liveness', agent_ids: aliveAgentIds, checked_agent_ids: checkedAgentIds })
  }

  function start() {
    if (deathCheckInterval) return
    deathCheckInterval = setInterval(check, deathCheckMs)
    setTimeout(check, 5000)
  }

  return {
    alivenessCache,
    check,
    clearTransientMissingState,
    noteActivity,
    start,
  }
}
