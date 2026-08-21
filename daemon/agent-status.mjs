import { execFile } from 'child_process'
import { promisify } from 'util'
import { exactTmuxWindowTarget } from '../shared/tmux-target.mjs'
import {
  classifyPane,
  decideThinkingEdge,
  shouldDisarm,
  THINKING_SCAN_LINES,
} from '../agent-runtime/status-classifier.mjs'
import { isObservableDaemonProcessBinding } from '../agent-runtime/daemon-process-binding.mjs'

const execFileP = promisify(execFile)

function commandValue(command, name) {
  const match = String(command || '').match(new RegExp(`(?:^|[ .])${name}=(?:"([^"]+)"|'([^']+)'|([^ ]+))`))
  return match?.[1] || match?.[2] || match?.[3] || null
}

function isCompleteProcessIdentity(agent, process) {
  return !!agent
    && typeof agent.id === 'string' && !!agent.id
    && typeof agent.daemonKey === 'string' && !!agent.daemonKey
    && typeof agent.friendly_name === 'string' && !!agent.friendly_name
    && typeof agent.runtimeKind === 'string' && !!agent.runtimeKind
    && agent.tmux_session === process.session
}

export async function fleetIdentityForPaneProcess({ session, pid } = {}) {
  if (!session || !Number.isSafeInteger(pid) || pid <= 0) return null
  const { stdout } = await execFileP('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  const id = commandValue(stdout, 'FLEET_ID')
  const daemonKey = commandValue(stdout, 'FLEET_DAEMON_KEY')
  if (!id || !daemonKey) return null
  return {
    id,
    daemonKey,
    friendly_name: commandValue(stdout, 'FLEET_NAME'),
    tmux_session: session,
    runtimeKind: commandValue(stdout, 'FLEET_HARNESS'),
    metadata: { kind: commandValue(stdout, 'FLEET_HARNESS') },
  }
}

export function createAgentStatus({
  tmuxArgs,
  sendMsg,
  log,
  getAgents,
  harnessForAgent,
  listSessions,
  resolveProcessIdentity = fleetIdentityForPaneProcess,
  isConnected,
  daemonKey,
  daemonBootId,
  statusScanMs,
  statusLingerMs = parseInt(process.env.TLDA_STATUS_LINGER_MS, 10) || 30_000,
  idleConfirmScans = 2,
  setIntervalFn = setInterval,
  capturePane = tmuxSession => execFileP('tmux',
    [...(tmuxArgs || []), 'capture-pane', '-t', exactTmuxWindowTarget(tmuxSession), '-p', '-S', `-${THINKING_SCAN_LINES}`],
    { timeout: 3000, encoding: 'utf8' }),
} = {}) {
  if (!Number.isFinite(statusScanMs) || statusScanMs <= 0) {
    throw new Error(`createAgentStatus requires statusScanMs (got ${JSON.stringify(statusScanMs)}) — set statusScanSeconds in daemon.yaml`)
  }
  if (typeof listSessions !== 'function') throw new Error('createAgentStatus requires listSessions')

  let statusScanInterval = null
  let reportSeq = 0
  const armedSince = new Map()
  const idleScans = new Map()
  const classifierState = new Map()
  const effectiveThinking = new Map()
  const prevApprovalFP = new Map()
  const pendingTools = new Map()
  let scanInFlight = false
  let scanAgain = false

  function isArmed(agentId) {
    return armedSince.has(agentId)
  }

  function armAgent(agentId) {
    if (agentId) armedSince.set(agentId, Date.now())
  }

  function armBySession(tmuxSession) {
    if (!tmuxSession) return
    for (const agent of getAgents()) {
      if (agent.daemonKey === daemonKey
        && agent.tmux_session === tmuxSession
        && isObservableDaemonProcessBinding(agent)) armAgent(agent.id)
    }
  }

  function disarmAgent(agentId) {
    armedSince.delete(agentId)
    idleScans.delete(agentId)
    classifierState.delete(agentId)
    effectiveThinking.delete(agentId)
    prevApprovalFP.delete(agentId)
    pendingTools.delete(agentId)
  }

  function noteToolActivity(agentId, tool) {
    if (!agentId || !tool || String(tool).startsWith('_')) return
    pendingTools.set(agentId, { tool: String(tool) })
    armAgent(agentId)
  }

  function thinkingState(agentId, isThinking) {
    const decision = decideThinkingEdge(
      effectiveThinking.get(agentId) === true,
      idleScans.get(agentId) || 0,
      isThinking,
      idleConfirmScans,
    )
    effectiveThinking.set(agentId, decision.prev)
    if (decision.idleCount) idleScans.set(agentId, decision.idleCount)
    else idleScans.delete(agentId)
    return decision.prev
  }

  async function inspectArmedPane(agent) {
    let pane
    try {
      pane = (await capturePane(agent.tmux_session)).stdout
    } catch {
      disarmAgent(agent.id)
      return { activity: 'unknown', tool: null, busy: false }
    }

    const classified = classifyPane(
      harnessForAgent(agent).kind,
      pane,
      classifierState.get(agent.id) || null,
      Date.now(),
    )
    if (classified.state) classifierState.set(agent.id, classified.state)
    else classifierState.delete(agent.id)

    const thinking = thinkingState(agent.id, classified.thinking)
    const activity = classified.approval
      ? 'needs_terminal_attention'
      : classified.compacting
        ? 'compacting'
        : thinking
          ? 'thinking'
          : 'idle'

    if (classified.approval) {
      if (classified.approvalFp !== prevApprovalFP.get(agent.id)) {
        prevApprovalFP.set(agent.id, classified.approvalFp)
        sendMsg({ type: 'terminal_attention', agent_id: agent.id, reason: 'permission prompt', text: 'permission prompt' })
      }
    } else {
      prevApprovalFP.delete(agent.id)
    }

    return { activity, tool: null, busy: classified.thinking || classified.compacting }
  }

  async function scanStatus(reason = 'periodic-status-scan') {
    if (scanInFlight) {
      scanAgain = true
      return
    }
    if (!isConnected()) return
    scanInFlight = true
    try {
      do {
        scanAgain = false
        let listed
        try {
          listed = await listSessions()
        } catch (error) {
          log?.warn?.(`agent status session list failed (${reason}): ${error.message}`)
          return
        }

        const now = Date.now()
        let liveAgents
        try {
          const processes = listed.processes || []
          const identities = await Promise.all(processes.map(resolveProcessIdentity))
          if (identities.some((agent, index) => !isCompleteProcessIdentity(agent, processes[index]))) {
            throw new Error('a listed pane has no complete fleet process identity')
          }
          liveAgents = identities.filter(agent => agent.daemonKey === daemonKey)
          const liveIds = new Set()
          for (const agent of liveAgents) {
            if (liveIds.has(agent.id)) throw new Error(`duplicate live fleet identity ${agent.id}`)
            liveIds.add(agent.id)
          }
        } catch (error) {
          log?.warn?.(`agent status process identity scan failed (${reason}): ${error.message}`)
          return
        }
        const results = []
        for (const agent of liveAgents) {
          let observed = { activity: 'unknown', tool: null, busy: false }
          if (isArmed(agent.id)) observed = await inspectArmedPane(agent)
          const toolObservation = pendingTools.get(agent.id)
          if (toolObservation) {
            observed = {
              activity: `tool_call:${toolObservation.tool}`,
              tool: toolObservation.tool,
              busy: true,
            }
            if (pendingTools.get(agent.id) === toolObservation) pendingTools.delete(agent.id)
          }
          results.push({
            agent_id: agent.id,
            status: 'awake',
            activity: observed.activity,
            tool: observed.tool,
            identity: { friendly_name: agent.friendly_name, runtime_kind: agent.runtimeKind },
          })
          if (observed.busy) armedSince.set(agent.id, now)
          else if (isArmed(agent.id) && shouldDisarm(now, armedSince.get(agent.id) || 0, false, statusLingerMs)) {
            disarmAgent(agent.id)
          }
        }

        reportSeq += 1
        const ts = new Date().toISOString()
        sendMsg({
          type: 'agent-status',
          agents: results,
          snapshot_complete: true,
          daemon_key: daemonKey,
          daemon_boot_id: daemonBootId,
          report_seq: reportSeq,
          reason,
          ts,
        })
      } while (scanAgain && isConnected())
    } finally {
      scanInFlight = false
      if (scanAgain && isConnected()) void scanStatus(reason)
    }
  }

  function start() {
    const initialScan = scanStatus('status-watcher-start')
    if (statusScanInterval) return initialScan
    statusScanInterval = setIntervalFn(() => { void scanStatus() }, statusScanMs)
    statusScanInterval?.unref?.()
    return initialScan
  }

  return {
    armAgent,
    armBySession,
    isArmed,
    noteToolActivity,
    scanStatus,
    start,
  }
}
