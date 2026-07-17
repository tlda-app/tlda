import { execFile } from 'child_process'
import { promisify } from 'util'
import { THINKING_SCAN_LINES } from '../agent-runtime/status-classifier.mjs'
import { gooseActivityTick } from '../agent-runtime/goose-activity.mjs'
import { maybeKickGoose, resolveGooseStatus } from '../agent-runtime/goose-kick.mjs'
import { isObservableDaemonProcessBinding } from '../agent-runtime/daemon-process-binding.mjs'

const execFileP = promisify(execFile)

export function createGooseSupervisor({
  tmuxArgs,
  log,
  getAgents,
  harnessForAgent,
  bufferActivity,
  isNoise,
  sendText,
  activityMs = 3000,
}) {
  const TMUX_ARGS = tmuxArgs || []
  const activityLastSeen = new Map()
  const prevGooseLive = new Map()
  const gooseKickState = new Map()
  let activityInterval = null

  function startActivityPolling() {
    if (activityInterval) return
    activityInterval = setInterval(() => {
      gooseActivityTick(getAgents(), {
        bufferActivity,
        log,
        lastSeen: activityLastSeen,
        isNoise,
      })
    }, activityMs)
  }

  async function kickSweep(candidateAgents) {
    for (const agent of candidateAgents) {
      if (!isObservableDaemonProcessBinding(agent)) continue
      if (harnessForAgent(agent).kind !== 'goose') continue
      try {
        const { stdout: pane } = await execFileP('tmux',
          [...TMUX_ARGS, 'capture-pane', '-t', agent.tmux_session, '-p', '-S', `-${THINKING_SCAN_LINES}`],
          { timeout: 3000, encoding: 'utf8' })
        const paneBottom = pane.split('\n').slice(-THINKING_SCAN_LINES).join('\n')
        const { status, live } = resolveGooseStatus(paneBottom, prevGooseLive.get(agent.id), Date.now())
        if (live) prevGooseLive.set(agent.id, live)
        else prevGooseLive.delete(agent.id)
        await maybeKickGoose(agent, status, {
          sendText,
          execFileP,
          log,
          stateMap: gooseKickState,
        })
      } catch {
        // capture-pane failed (tmux session gone / transient churn); liveness
        // handles genuinely dead sessions, so this sweep just skips the agent.
      }
    }
  }

  return {
    kickSweep,
    startActivityPolling,
  }
}
