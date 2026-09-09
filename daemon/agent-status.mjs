import { execFile } from 'child_process'
import { promisify } from 'util'
import { exactTmuxWindowTarget } from '../shared/tmux-target.mjs'
import { classifyPane, shouldDisarm, THINKING_SCAN_LINES } from '../agent-runtime/status-classifier.mjs'
import { isObservableDaemonProcessBinding } from '../agent-runtime/daemon-process-binding.mjs'

const execFileP = promisify(execFile)

const STATUS = Object.freeze({
  THINKING: 'thinking',
  COMPACTING: 'compacting',
  IDLE: 'idle',
  UNKNOWN: 'unknown',
})

const LIVE = new Set([STATUS.THINKING, STATUS.COMPACTING])

function paneActivity(harnessKind, pane, prevState, now) {
  const classified = classifyPane(harnessKind, pane, prevState, now)
  const activity = classified.compacting
    ? STATUS.COMPACTING
    : classified.thinking || classified.approval
      ? STATUS.THINKING
      : STATUS.IDLE
  return { activity, state: classified.state || null }
}

function decideActivityEdge(prev, pending, next, confirm = 2) {
  if (next === prev) return { emit: null, prev, pending: null }
  if (LIVE.has(next)) return { emit: next, prev: next, pending: null }
  const count = (pending?.activity === next ? pending.count : 0) + 1
  if (count >= confirm) return { emit: next, prev: next, pending: null }
  return { emit: null, prev, pending: { activity: next, count } }
}

export function createAgentStatus({
  tmuxArgs,
  sendMsg,
  log,
  getAgents,
  harnessForAgent,
  isConnected,
  statusScanMs,
  statusLingerMs = 30_000,
  idleConfirmScans = 2,
  setIntervalFn = setInterval,
  capturePane = (tmuxSession) => execFileP('tmux',
    [...(tmuxArgs || []), 'capture-pane', '-t', exactTmuxWindowTarget(tmuxSession), '-p', '-S', `-${THINKING_SCAN_LINES}`],
    { timeout: 3000, encoding: 'utf8' }),
} = {}) {
  if (!Number.isFinite(statusScanMs) || statusScanMs <= 0) {
    throw new Error(`createAgentStatus requires statusScanMs (got ${JSON.stringify(statusScanMs)})`)
  }

  let interval = null
  let scanInFlight = false
  let scanAgain = false
  const armedSince = new Map()
  const pendingActivity = new Map()
  const classifierState = new Map()
  const prevActivity = new Map()
  const latestTool = new Map()

  function isArmed(agentId) {
    return armedSince.has(agentId)
  }

  function armAgent(agentId) {
    if (agentId) armedSince.set(agentId, Date.now())
  }

  function armBySession(tmuxSession) {
    if (!tmuxSession) return
    for (const agent of getAgents()) {
      if (agent.tmux_session === tmuxSession && isObservableDaemonProcessBinding(agent)) armAgent(agent.id)
    }
  }

  function noteToolActivity(agentId, tool) {
    if (agentId && tool) latestTool.set(agentId, tool)
  }

  function disarmAgent(agentId) {
    armedSince.delete(agentId)
    pendingActivity.delete(agentId)
    classifierState.delete(agentId)
    prevActivity.delete(agentId)
    latestTool.delete(agentId)
  }

  function emitActivityEdge(agentId, next) {
    const decision = decideActivityEdge(
      prevActivity.get(agentId) || null,
      pendingActivity.get(agentId) || null,
      next,
      idleConfirmScans,
    )
    if (decision.prev) prevActivity.set(agentId, decision.prev)
    if (decision.pending) pendingActivity.set(agentId, decision.pending)
    else pendingActivity.delete(agentId)
    if (decision.emit !== null) {
      const tool = LIVE.has(decision.emit) ? latestTool.get(agentId) || null : null
      log?.info?.(`agent activity transition: agent=${agentId} activity=${decision.emit}`)
      sendMsg({ type: 'agent-status', agent_id: agentId, activity: decision.emit, tool, ts: new Date().toISOString() })
    }
    return decision.prev
  }

  async function scanAgent(agent) {
    let pane = null
    try {
      ;({ stdout: pane } = await capturePane(agent.tmux_session))
    } catch {
      emitActivityEdge(agent.id, STATUS.UNKNOWN)
      armedSince.delete(agent.id)
      return false
    }

    const classified = paneActivity(
      harnessForAgent(agent).kind,
      pane,
      classifierState.get(agent.id) || null,
      Date.now(),
    )
    if (classified.state) classifierState.set(agent.id, classified.state)
    else classifierState.delete(agent.id)
    const effective = emitActivityEdge(agent.id, classified.activity)
    return LIVE.has(classified.activity) || LIVE.has(effective)
  }

  async function scanStatus() {
    if (scanInFlight) {
      scanAgain = true
      return
    }
    if (!isConnected?.()) return
    if (!armedSince.size) return
    scanInFlight = true
    try {
      do {
        scanAgain = false
        const now = Date.now()
        const agents = getAgents()
        for (const agentId of [...armedSince.keys()]) {
          const agent = agents.find(row => row.id === agentId)
          if (!isObservableDaemonProcessBinding(agent)) {
            disarmAgent(agentId)
            continue
          }
          let busy = false
          try { busy = await scanAgent(agent) } catch { busy = false }
          if (busy) armedSince.set(agentId, now)
          else if (shouldDisarm(now, armedSince.get(agentId) || 0, false, statusLingerMs)) disarmAgent(agentId)
        }
      } while (scanAgain && isConnected?.() && armedSince.size)
    } finally {
      scanInFlight = false
      if (scanAgain && isConnected?.() && armedSince.size) void scanStatus()
    }
  }

  function start() {
    if (interval) return
    log?.info?.('agent status watcher sync: armed=0')
    interval = setIntervalFn(scanStatus, statusScanMs)
    interval?.unref?.()
  }

  return { armAgent, armBySession, isArmed, noteToolActivity, scanStatus, start }
}
