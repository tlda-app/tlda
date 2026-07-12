export const DEFAULT_SUPERVISED_START_TIMEOUT_MS = 30_000
export const DEFAULT_DIRECT_FALLBACK_TIMEOUT_MS = 30_000

export class DaemonTransitionFailed extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'DaemonTransitionFailed'
    Object.assign(this, details)
  }
}

export function parseLaunchdPid(output) {
  const pidLine = String(output || '').split('\n').find(line => line.trim().startsWith('pid ='))
  const pid = pidLine ? parseInt(pidLine.split('=')[1], 10) : null
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

export function parseFleetDaemonPids(psOutput) {
  return String(psOutput || '').split('\n')
    .map(line => line.trim())
    .filter(line => /node .*bin\/fleet-daemon\.mjs/.test(line))
    .map(line => parseInt(line.split(/\s+/, 1)[0], 10))
    .filter(pid => Number.isFinite(pid) && pid > 0)
}

export function assertTargetEnvironmentDaemon({
  expectedPid,
  lockInspection,
  pidFilePid = null,
  launchdPid = null,
  launchdOwnsDaemon = false,
  observedDaemonPids = null,
}) {
  if (!Number.isFinite(expectedPid) || expectedPid <= 0) {
    throw new Error(`target daemon verification needs a positive pid, got ${expectedPid}`)
  }
  if (!lockInspection?.held) {
    throw new Error('target daemon singleton lock is not held')
  }
  const holderPid = lockInspection.holder?.pid
  if (holderPid && holderPid !== expectedPid) {
    throw new Error(`target daemon lock held by pid ${holderPid}, expected ${expectedPid}`)
  }
  if (pidFilePid && pidFilePid !== expectedPid) {
    throw new Error(`target daemon pidfile points at pid ${pidFilePid}, expected ${expectedPid}`)
  }
  if (launchdPid && launchdPid !== expectedPid && !launchdOwnsDaemon) {
    throw new Error(`target daemon launchd job reports pid ${launchdPid}, expected ${expectedPid}`)
  }
  if (observedDaemonPids && !observedDaemonPids.includes(expectedPid)) {
    throw new Error(`target daemon pid ${expectedPid} is not in the observed process list`)
  }
  return true
}

export function isCompleteTargetDaemonReady({
  expectedPid,
  lockInspection,
  pidFilePid = null,
  launchdPid = null,
  launchdOwnsDaemon = false,
  observedDaemonPids = null,
  flyWsConnected = false,
  watcherReady = false,
}) {
  try {
    assertTargetEnvironmentDaemon({
      expectedPid,
      lockInspection,
      pidFilePid,
      launchdPid,
      launchdOwnsDaemon,
      observedDaemonPids,
    })
  } catch (e) {
    return { ready: false, reason: e.message }
  }
  if (!flyWsConnected) return { ready: false, reason: 'target daemon has no established Fly WS connection' }
  if (!watcherReady) return { ready: false, reason: 'target daemon has no watcher-ready evidence' }
  return { ready: true, reason: 'ready' }
}

export function daemonReadyLogEvidence(logText, { pid, server, machineId, envName } = {}) {
  const lines = String(logText || '').split('\n')
  let seenStart = false
  for (const line of lines) {
    if (line.includes(`fleet-daemon`) && line.includes(`starting pid=${pid}`)) {
      seenStart = true
      continue
    }
    if (!seenStart) continue
    if (
      line.includes(`daemon-ready pid=${pid}`) &&
      line.includes(`server=${server}`) &&
      line.includes(`machine_id=${machineId}`) &&
      line.includes(`env_name=${envName}`) &&
      line.includes('watchers=started')
    ) {
      return true
    }
  }
  return false
}

export async function terminatePidAndWait({
  pid,
  timeoutMs = 10_000,
  pollMs = 100,
  signal = 'SIGTERM',
  killPid = (targetPid, targetSignal) => process.kill(targetPid, targetSignal),
  isPidAlive = (targetPid) => {
    try {
      process.kill(targetPid, 0)
      return true
    } catch (e) {
      if (e?.code === 'ESRCH') return false
      throw e
    }
  },
  inspectLock = () => ({ held: false, holder: {} }),
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`daemon termination needs a positive pid, got ${pid}`)
  }

  try {
    killPid(pid, signal)
  } catch (e) {
    if (e?.code !== 'ESRCH') throw e
  }

  const deadline = Date.now() + timeoutMs
  let lastReason = 'process still alive'
  while (Date.now() < deadline) {
    const alive = isPidAlive(pid)
    const lock = inspectLock()
    const heldByPid = !!(lock?.held && lock?.holder?.pid === pid)
    if (!alive && !heldByPid) return true
    if (alive && heldByPid) lastReason = `pid ${pid} still alive and holding target daemon lock`
    else if (alive) lastReason = `pid ${pid} still alive`
    else lastReason = `pid ${pid} exited but target daemon lock is still held by that pid`
    await sleep(pollMs)
  }
  throw new Error(`timed out waiting for daemon pid ${pid} to stop: ${lastReason}`)
}

export async function pollTargetDaemonReadiness({
  previousPid = null,
  timeoutMs = DEFAULT_SUPERVISED_START_TIMEOUT_MS,
  pollMs = 500,
  getCandidatePid,
  inspectReadiness,
}) {
  const deadline = Date.now() + timeoutMs
  let lastReason = 'no candidate pid'
  while (Date.now() < deadline) {
    const pid = await getCandidatePid()
    if (pid && pid !== previousPid) {
      const state = await inspectReadiness(pid)
      if (state?.ready) return { pid, ready: true }
      lastReason = state?.reason || 'not ready'
    }
    await new Promise(r => setTimeout(r, pollMs))
  }
  return { pid: null, ready: false, reason: lastReason }
}

export async function runDaemonStartWithSupervisedNoop({
  existingPid,
  getLaunchdPid,
  launchdOwnsExisting = async (launchdPid, daemonPid) => launchdPid === daemonPid,
  verifyTargetDaemon,
  runBoundedTransition,
}) {
  const launchdPid = await getLaunchdPid()
  if (existingPid && launchdPid && await launchdOwnsExisting(launchdPid, existingPid)) {
    await verifyTargetDaemon(existingPid, { supervised: true })
    return { mode: 'already-supervised', pid: existingPid }
  }
  return runBoundedTransition()
}

export async function runBoundedDaemonStartTransition({
  existingPid,
  log = () => {},
  writePlist,
  bootstrap,
  stopExisting,
  waitSupervised,
  startDirectFallback,
  verifyTargetDaemon,
  stageRecoveryAction,
  supervisedTimeoutMs = DEFAULT_SUPERVISED_START_TIMEOUT_MS,
  fallbackTimeoutMs = DEFAULT_DIRECT_FALLBACK_TIMEOUT_MS,
}) {
  if (!existingPid) {
    throw new Error('bounded daemon transition requires an existing outside daemon pid')
  }

  log({
    type: 'bounded-start-transition',
    existingPid,
    supervisedTimeoutMs,
    fallbackTimeoutMs,
  })

  await writePlist()
  await bootstrap()
  await stopExisting(existingPid)

  let supervisedFailure = null
  try {
    const supervisedPid = await waitSupervised({ previousPid: existingPid, timeoutMs: supervisedTimeoutMs })
    if (supervisedPid) {
      await verifyTargetDaemon(supervisedPid, { supervised: true })
      return { mode: 'supervised', pid: supervisedPid, fallbackUsed: false }
    }
  } catch (e) {
    supervisedFailure = e
  }

  let fallbackFailure = null
  try {
    const fallbackPid = await startDirectFallback({ previousPid: existingPid, timeoutMs: fallbackTimeoutMs })
    if (fallbackPid) {
      await verifyTargetDaemon(fallbackPid, { supervised: false })
      return { mode: 'direct-fallback', pid: fallbackPid, fallbackUsed: true }
    }
  } catch (e) {
    fallbackFailure = e
  }

  const recovery = await stageRecoveryAction?.({
    stoppedPid: existingPid,
    supervisedTimeoutMs,
    fallbackTimeoutMs,
    supervisedFailure,
    fallbackFailure,
  })
  throw new DaemonTransitionFailed(
    `fleet daemon bounded transition failed after stopping pid ${existingPid}: supervised launchd did not start within ${supervisedTimeoutMs}ms and direct fallback did not start within ${fallbackTimeoutMs}ms`,
    { daemonless: true, recovery, supervisedFailure, fallbackFailure },
  )
}
