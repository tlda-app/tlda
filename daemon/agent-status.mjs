import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  classifyPane,
  decideThinkingEdge,
  shouldDisarm,
  THINKING_SCAN_LINES,
} from '../agent-runtime/status-classifier.mjs'
import { isObservableDaemonProcessBinding } from '../agent-runtime/daemon-process-binding.mjs'

const execFileP = promisify(execFile)

export function createAgentStatus({
  tmuxArgs,
  sendMsg,
  log,
  getAgents,
  harnessForAgent,
  isConnected,
  // Required, from daemon.yaml `statusScanSeconds` via getStatusScanMs(). No env
  // var and no hardcoded default: a silent `|| 5000` is the generic-config
  // fallback pattern this codebase is removing, and it hid the polling cadence
  // from the one place operators look.
  //
  // BEFORE YOU LOWER THIS — measure what it multiplies. Two commands run per
  // scan and they cost very differently:
  //
  //   tmux list-sessions   ~18ms   ONCE for the whole box, flat in agent count
  //   tmux capture-pane    ~18ms   PER ARMED AGENT, and run serially below
  //
  // Measured on the Mini, 2026-07-25, 13 live sessions: list-sessions 18.0ms
  // (min 15.2, max 25.7, n=30); capture-pane across all 13 took 234.9ms serial,
  // 77.2ms if issued in parallel — which this loop does not do.
  //
  // So the poll's cost is dominated by capture-pane and scales with the number
  // of ARMED agents, not with the roster. Serially, 13 armed agents cost:
  //
  //   at 30s   0.78% of a core
  //   at 2.5s  9.4%  of a core        ← 12x, permanently, per box
  //
  // Going parallel buys ~3x and would make a 2-3s cadence affordable; leaving it
  // serial makes that cadence expensive. This is the enumerate-per-agent pattern
  // (docs/fleet-design-rules.md) — list-sessions answers a question for the whole
  // box in one command, capture-pane asks it once per agent.
  //
  // The daemon is not the only cost either: applying liveness on the SERVER has
  // its own per-report cost that scales with roster size. That is a different
  // machine and a different mechanism — neither number answers the other.
  statusScanMs,
  statusLingerMs = parseInt(process.env.TLDA_STATUS_LINGER_MS, 10) || 30_000,
  idleConfirmScans = 2,
  setIntervalFn = setInterval,
  capturePane = (tmuxSession) => execFileP('tmux',
    [...(tmuxArgs || []), 'capture-pane', '-t', tmuxSession, '-p', '-S', `-${THINKING_SCAN_LINES}`],
    { timeout: 3000, encoding: 'utf8' }),
}) {
  if (!Number.isFinite(statusScanMs) || statusScanMs <= 0) {
    throw new Error(`createAgentStatus requires statusScanMs (got ${JSON.stringify(statusScanMs)}) — set statusScanSeconds in daemon.yaml`)
  }
  let statusScanInterval = null
  const armedSince = new Map()
  const idleScans = new Map()
  const classifierState = new Map()
  const prevThinking = new Map()
  const prevCompacting = new Map()
  const prevAgentStatus = new Map()
  const prevApprovalFP = new Map()
  let scanInFlight = false
  let scanAgain = false

  function isArmed(agentId) {
    return armedSince.has(agentId)
  }

  function armAgent(agentId) {
    if (agentId) armedSince.set(agentId, Date.now())
  }

  function armBySession(tmux_session) {
    if (!tmux_session) return
    for (const agent of getAgents()) {
      if (agent.tmux_session !== tmux_session) continue
      if (isObservableDaemonProcessBinding(agent)) armAgent(agent.id)
    }
  }

  function emitAgentStatus(agentId, state, tool = null) {
    if (!agentId || !state) return
    if (prevAgentStatus.get(agentId) === state) return
    prevAgentStatus.set(agentId, state)
    log?.info?.(`agent status transition: agent=${agentId} state=${state}`)
    sendMsg({ type: 'agent-status', agentId, state, tool, ts: new Date().toISOString() })
  }

  function disarmAgent(agentId) {
    if (prevThinking.get(agentId) === true) sendMsg({ type: 'agent-thinking', agentId, thinking: false })
    if (prevCompacting.get(agentId) === true) sendMsg({ type: 'agent-compacting', agentId, compacting: false })
    armedSince.delete(agentId)
    idleScans.delete(agentId)
    classifierState.delete(agentId)
    prevThinking.delete(agentId)
    prevCompacting.delete(agentId)
    prevApprovalFP.delete(agentId)
  }

  function emitThinkingEdge(agentId, isThinking) {
    const decision = decideThinkingEdge(
      prevThinking.get(agentId) === true,
      idleScans.get(agentId) || 0,
      isThinking,
      idleConfirmScans,
    )
    prevThinking.set(agentId, decision.prev)
    if (decision.idleCount) idleScans.set(agentId, decision.idleCount)
    else idleScans.delete(agentId)
    if (decision.emit !== null) sendMsg({ type: 'agent-thinking', agentId, thinking: decision.emit })
    return decision.prev
  }

  function emitCompactingEdge(agentId, isCompacting) {
    if (isCompacting !== (prevCompacting.get(agentId) === true)) {
      prevCompacting.set(agentId, isCompacting)
      sendMsg({ type: 'agent-compacting', agentId, compacting: isCompacting })
    }
    return isCompacting
  }

  async function scanAgentPaneStatus(agent) {
    let pane
    try {
      const { stdout } = await capturePane(agent.tmux_session)
      pane = stdout
    } catch {
      const effectiveThinking = emitThinkingEdge(agent.id, false)
      const effectiveCompacting = emitCompactingEdge(agent.id, false)
      if (!effectiveThinking && !effectiveCompacting) emitAgentStatus(agent.id, 'hibernating')
      disarmAgent(agent.id)
      return { busy: false }
    }

    const classified = classifyPane(
      harnessForAgent(agent).kind,
      pane,
      classifierState.get(agent.id) || null,
      Date.now(),
    )
    if (classified.state) classifierState.set(agent.id, classified.state)
    else classifierState.delete(agent.id)

    const effectiveThinking = emitThinkingEdge(agent.id, classified.thinking)
    const effectiveCompacting = emitCompactingEdge(agent.id, classified.compacting)

    const statusState = classified.approval
      ? 'needs_terminal_attention'
      : effectiveCompacting
        ? 'compacting'
        : effectiveThinking
          ? 'thinking'
          : 'idle'
    emitAgentStatus(agent.id, statusState)

    if (classified.approval) {
      if (classified.approvalFp !== prevApprovalFP.get(agent.id)) {
        prevApprovalFP.set(agent.id, classified.approvalFp)
        sendMsg({ type: 'terminal_attention', agent_id: agent.id, reason: 'permission prompt', text: 'permission prompt' })
      }
    } else {
      prevApprovalFP.delete(agent.id)
    }
    return { busy: classified.thinking || classified.compacting }
  }

  async function scanArmedStatus() {
    if (scanInFlight) {
      scanAgain = true
      return
    }
    if (!isConnected()) return
    if (!armedSince.size) return
    scanInFlight = true
    try {
      do {
        scanAgain = false
        const now = Date.now()
        const agents = getAgents()
        for (const agentId of [...armedSince.keys()]) {
          const agent = agents.find(a => a.id === agentId)
          if (!isObservableDaemonProcessBinding(agent)) {
            disarmAgent(agentId)
            continue
          }
          let busy = false
          try { ({ busy } = await scanAgentPaneStatus(agent)) } catch { busy = false }
          if (busy) {
            armedSince.set(agentId, now)
          } else if (shouldDisarm(now, armedSince.get(agentId) || 0, false, statusLingerMs)) {
            disarmAgent(agentId)
          }
        }
      } while (scanAgain && isConnected() && armedSince.size)
    } finally {
      scanInFlight = false
      if (scanAgain && isConnected() && armedSince.size) {
        void scanArmedStatus()
      }
    }
  }

  function start() {
    if (statusScanInterval) return
    log?.info?.('agent status watcher sync: armed=0')
    statusScanInterval = setIntervalFn(scanArmedStatus, statusScanMs)
    statusScanInterval?.unref?.()
  }

  return {
    armAgent,
    armBySession,
    emitAgentStatus,
    isArmed,
    scanArmedStatus,
    start,
  }
}
