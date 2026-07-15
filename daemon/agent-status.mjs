import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  classifyPane,
  decideThinkingEdge,
  THINKING_SCAN_LINES,
} from '../agent-runtime/status-classifier.mjs'

const execFileP = promisify(execFile)

export function createAgentStatus({
  tmuxArgs,
  sendMsg,
  log,
  getAgents,
  harnessForAgent,
  isConnected,
  statusScanMs = parseInt(process.env.TLDA_STATUS_SCAN_MS, 10) || 5000,
  idleConfirmScans = 2,
  setIntervalFn = setInterval,
  capturePane = (tmuxSession) => execFileP('tmux',
    [...(tmuxArgs || []), 'capture-pane', '-t', tmuxSession, '-p', '-S', `-${THINKING_SCAN_LINES}`],
    { timeout: 3000, encoding: 'utf8' }),
}) {
  let statusScanInterval = null
  const armedSince = new Map()
  const idleScans = new Map()
  const classifierState = new Map()
  const prevThinking = new Map()
  const prevCompacting = new Map()
  const prevAgentStatus = new Map()
  const prevApprovalFP = new Map()

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
      if (!agent.dead && !agent.human && !agent.hibernating) armAgent(agent.id)
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
    if (!isConnected()) return
    if (!armedSince.size) return
    const now = Date.now()
    for (const agentId of [...armedSince.keys()]) {
      const agent = getAgents().find(a => a.id === agentId)
      if (!agent || agent.dead || agent.human || agent.hibernating || !agent.tmux_session) {
        disarmAgent(agentId)
        continue
      }
      let busy = false
      try { ({ busy } = await scanAgentPaneStatus(agent)) } catch { busy = false }
      if (busy) {
        armedSince.set(agentId, now)
      }
    }
  }

  function start() {
    let armed = 0
    for (const agent of getAgents()) {
      if (!agent?.dead && !agent?.human && !agent?.hibernating && agent?.tmux_session) {
        armAgent(agent.id)
        armed += 1
      }
    }
    log?.info?.(`agent status watcher sync: armed=${armed}`)
    void scanArmedStatus()
    if (statusScanInterval) return
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
