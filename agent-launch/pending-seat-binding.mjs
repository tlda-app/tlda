import fs from 'fs'

export function reuseExactPendingSeatBinding({ obligation, identity, seat, local } = {}) {
  if (
    seat?.agent_id !== obligation?.agent_id ||
    seat?.session_id !== identity?.sessionId ||
    seat?.daemon_key !== obligation?.daemon_key ||
    !seat?.terminal_capability ||
    local?.terminalCapability !== seat.terminal_capability
  ) return null
  return { bound: true, seat, payload: seat, reused: true }
}

export function createPendingSeatBindingManager({
  watchPath,
  resolveIdentity,
  tmuxAlive,
  complete,
  terminal,
  watch = fs.watch,
  setPeriodic = setInterval,
  clearPeriodic = clearInterval,
  retryIntervalMs = 1000,
  log = console,
} = {}) {
  const pending = new Map()
  const queuedAttemptIds = new Set()
  const attemptQueue = []
  let drainingAttempts = false

  function clearEntry(entry) {
    entry?.watcher?.close?.()
    if (entry?.timer) clearPeriodic(entry.timer)
  }

  function scheduleAttempt(obligation) {
    const id = obligation?.obligation_id
    if (!id || !pending.has(id) || queuedAttemptIds.has(id)) return
    queuedAttemptIds.add(id)
    attemptQueue.push(id)
    void drainAttempts()
  }

  async function drainAttempts() {
    if (drainingAttempts) return
    drainingAttempts = true
    try {
      while (attemptQueue.length) {
        const id = attemptQueue.shift()
        queuedAttemptIds.delete(id)
        const entry = pending.get(id)
        if (!entry) continue
        await attempt(entry.obligation)
      }
    } finally {
      drainingAttempts = false
      if (attemptQueue.length) void drainAttempts()
    }
  }

  async function attempt(obligation) {
    const entry = pending.get(obligation.obligation_id)
    if (!entry) return
    if (entry.inFlight) { entry.rerunRequested = true; return }
    entry.inFlight = true
    try {
      if (!(await tmuxAlive(obligation.tmux_session))) {
        await terminal(obligation, new Error('exact launched runtime is no longer alive'))
        clearEntry(pending.get(obligation.obligation_id))
        pending.delete(obligation.obligation_id)
        return
      }
      const identity = await resolveIdentity(obligation)
      if (!identity?.sessionId || !identity?.model) return
      await complete(obligation, identity)
      clearEntry(pending.get(obligation.obligation_id))
      pending.delete(obligation.obligation_id)
    } catch (error) {
      if (error?.terminalBindingFailure) {
        try {
          await terminal(obligation, error)
          clearEntry(pending.get(obligation.obligation_id))
          pending.delete(obligation.obligation_id)
        } catch (cleanupError) {
          log.warn?.(`terminal cleanup for ${obligation.obligation_id} remains pending: ${cleanupError.message}`)
        }
      } else {
        log.warn?.(`pending seat binding ${obligation.obligation_id} remains pending: ${error.message}`)
      }
    } finally {
      const current = pending.get(obligation.obligation_id)
      if (current) {
        current.inFlight = false
        if (current.rerunRequested) {
          current.rerunRequested = false
          scheduleAttempt(obligation)
        }
      }
    }
  }

  function accept(obligation) {
    if (!obligation?.obligation_id || pending.has(obligation.obligation_id)) return false
    const path = watchPath(obligation)
    const watcher = watch(path, { recursive: true }, () => { scheduleAttempt(obligation) })
    const timer = setPeriodic(() => { scheduleAttempt(obligation) }, retryIntervalMs)
    timer?.unref?.()
    pending.set(obligation.obligation_id, { obligation, watcher, timer, inFlight: false, rerunRequested: false })
    scheduleAttempt(obligation)
    return true
  }

  function close() {
    for (const entry of pending.values()) clearEntry(entry)
    pending.clear()
  }

  return { accept, attempt, close, has: id => pending.has(id), pendingCount: () => pending.size }
}

export async function cleanupPendingSeatBinding({
  obligation,
  error,
  terminateTmux,
  tmuxAlive,
  permissionLedger,
  openLocalLedger,
  retireServerReservation,
  emitTerminal,
} = {}) {
  await terminateTmux(obligation.tmux_session)
  if (await tmuxAlive(obligation.tmux_session)) {
    throw new Error(`terminal seat binding failed, but exact runtime ${obligation.tmux_session} is still live`)
  }
  await permissionLedger.delete(obligation.agent_id)
  if (permissionLedger.get(obligation.agent_id)) {
    throw new Error(`terminal seat binding failed to delete permission grant for ${obligation.agent_id}`)
  }
  if (obligation.local_agent_id) {
    const localLedger = openLocalLedger()
    try {
      if (localLedger.get(obligation.local_agent_id)) localLedger.delete(obligation.local_agent_id)
      if (localLedger.get(obligation.local_agent_id)) {
        throw new Error(`terminal seat binding failed to delete local recipe ${obligation.local_agent_id}`)
      }
    } finally {
      localLedger.close()
    }
  }
  const retired = await retireServerReservation(obligation.agent_id)
  if (retired?.ok !== true || retired?.retired !== true) {
    throw new Error(`terminal seat binding failed to verify retired reservation for ${obligation.agent_id}`)
  }
  await emitTerminal({
    type: 'agent-seat-binding-obligation-terminal',
    obligation_id: obligation.obligation_id,
    daemon_key: obligation.daemon_key,
    agent_id: obligation.agent_id,
    reason: error.message,
  })
}

export async function completePendingSeatBinding({
  obligation,
  identity,
  bindSeat,
  readExistingBinding = null,
  emitComplete,
} = {}) {
  const existing = await readExistingBinding?.()
  const binding = existing?.bound === true ? existing : await bindSeat()
  if (
    binding?.bound !== true ||
    binding?.seat?.agent_id !== obligation.agent_id ||
    binding?.seat?.session_id !== identity.sessionId ||
    !binding?.seat?.terminal_capability ||
    binding?.seat?.daemon_key !== obligation.daemon_key
  ) throw new Error(`exact durable seat readback remains pending for ${obligation.agent_id}`)
  await emitComplete({
    type: 'agent-seat-binding-obligation-complete',
    obligation_id: obligation.obligation_id,
    agent_id: obligation.agent_id,
    session_id: identity.sessionId,
    terminal_capability: binding.seat.terminal_capability,
  })
  return binding
}
