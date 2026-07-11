export const DEFAULT_SUPERVISED_START_TIMEOUT_MS = 30_000
export const DEFAULT_DIRECT_FALLBACK_TIMEOUT_MS = 30_000

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

export async function runBoundedDaemonStartTransition({
  existingPid,
  log = () => {},
  writePlist,
  bootstrap,
  stopExisting,
  waitSupervised,
  startDirectFallback,
  verifyExactlyOne,
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
    maxOutageMs: supervisedTimeoutMs + fallbackTimeoutMs,
  })

  await writePlist()
  await bootstrap()
  await stopExisting(existingPid)

  const supervisedPid = await waitSupervised({ previousPid: existingPid, timeoutMs: supervisedTimeoutMs })
  if (supervisedPid) {
    await verifyExactlyOne(supervisedPid)
    return { mode: 'supervised', pid: supervisedPid, fallbackUsed: false }
  }

  const fallbackPid = await startDirectFallback({ previousPid: existingPid, timeoutMs: fallbackTimeoutMs })
  if (fallbackPid) {
    await verifyExactlyOne(fallbackPid)
    return { mode: 'direct-fallback', pid: fallbackPid, fallbackUsed: true }
  }

  throw new Error(
    `fleet daemon bounded transition failed: supervised daemon did not start within ${supervisedTimeoutMs}ms, and direct fallback did not start within ${fallbackTimeoutMs}ms`,
  )
}
