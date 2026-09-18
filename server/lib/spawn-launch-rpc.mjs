import { daemonAddress, describeAgentAddress } from '../../shared/agent-move-target.mjs'
import { startWsRequest } from '../../shared/fleet-transport.mjs'

// The transport for the ops that bring an agent up, extracted from
// unified-server.mjs so it can be driven by a test. The server file cannot be
// imported without starting a server, and the two silences repaired here are
// timing behaviour rather than a return value, so there was nowhere for a test to
// stand. Collaborators are injected the same way server/lib/spawn-routing.mjs
// takes `daemonConnections`.

export class NoDaemonError extends Error {
  constructor(machineId, envName) {
    super(`No fleet-daemon connected for ${describeAgentAddress(machineId, envName)}`)
    this.code = 'NO_DAEMON'
    this.machineId = machineId
    this.envName = envName
  }
}

// The ops that bring an agent up. All three reach the daemon through
// performSpawnRelay, and all three want the same two behaviours: wait out a daemon
// reconnect rather than failing into it, and say so in the log when there is no
// routable daemon.
//
// This was written as `op === 'spawn'`, which reads as "the spawn path" and is
// not: performSpawnRelay sends the literal op 'mint' for a fresh agent and 'wake'
// for a respawn, and only 'spawn' for neither. So the reconnect grace and the miss
// log covered the one case out of three that a fresh mint never takes. A mint that
// met a stale socket got no reconnect wait and left no log line -- which is half of
// why hw3-writer could be requested, recorded as pending, and never appear
// anywhere. Matching the path by one of its op names is what made it silently
// partial.
export function isAgentLaunchOp(op) {
  return op === 'spawn' || op === 'mint' || op === 'wake'
}

// The launch RPC's two deadlines. They exist so the attempt ENDS: the durable
// sender only retries across a reconnect when an attempt finishes, so with both
// left null a single envelope written into a stale-but-open socket waits forever,
// the retry loop never runs a second iteration, and the spawn promise never
// settles. Nothing downstream recovers from that -- the spawn mailbox's expiry is
// deliberately not a failure verdict, and failServerMintShell is reachable only
// from inside the promise that never settled -- so the requester keeps
// `{ ok: true, pending: true }` and the shell row stays pending with no line in any
// log.
//
// These three numbers are ONE budget and must stay ordered, for the reason given
// at MIRROR_KEY_TIMEOUT_MS: a layer that gives up before the layer beneath it is
// allowed to finish turns slow work into a reported failure.
//
//   attempt            60s   abandons a socket that is not answering
//   daemon rpcMint    300s   mintRegistrationDeadlineSeconds (shared/config.mjs)
//   total             330s   outlasts the daemon so its verdict is still received
//
// The attempt is the short one on purpose, and re-sending is safe rather than
// merely tolerable: every attempt reuses one request id, and the daemon binds that
// id to the operation and payload fingerprint (daemon/machine-rpc.mjs), so a
// re-send during a launch still running attaches to the in-flight execution and
// returns its one result. The side effect happens once.
export const DAEMON_LAUNCH_RPC_ATTEMPT_MS = Number(process.env.TLDA_DAEMON_LAUNCH_RPC_ATTEMPT_MS || 60_000)
export const DAEMON_LAUNCH_RPC_TOTAL_MS = Number(process.env.TLDA_DAEMON_LAUNCH_RPC_TOTAL_MS || 330_000)

export function launchRpcOptions() {
  return {
    attemptTimeoutMs: DAEMON_LAUNCH_RPC_ATTEMPT_MS,
    totalDeadlineMs: DAEMON_LAUNCH_RPC_TOTAL_MS,
  }
}

// One line naming what the server still holds at the moment a spawn's mailbox
// deadline passes. Not a failure verdict -- see the caller -- but the last point
// at which the name, the reserved agent id, the daemon asked, and the wait are all
// still in hand.
export function spawnMailboxExpiryLine(entry, nowMs) {
  const waitedMs = nowMs - entry.startedAt
  return `[spawn] mailbox deadline passed with no launch verdict: `
    + `name=${entry.meta?.name || '(unnamed)'} `
    + `agent_id=${entry.meta?.agentId || '(none)'} `
    + `daemon=${entry.meta?.machineId || '(unknown)'} `
    + `fresh=${!!entry.meta?.fresh} respawn=${!!entry.meta?.respawn} owner=${entry.ownerId} `
    + `waited_ms=${waitedMs} mailbox=${entry.id} observed_at=${new Date(nowMs).toISOString()} `
    + `-- the agent may still log in; this is not a failure verdict`
}

export function createDaemonRpcSender({
  daemonConnections,
  daemonWelcomeSeenAt,
  pendingRpcs,
  waitForDaemonReady,
  isTransientRpcError,
  logSpawnDaemonMiss,
  reconnectGraceMs,
  now = () => Date.now(),
}) {
  let rpcSeq = 0

  async function attempt(machineId, op, params = {}, opts = {}) {
    let targetMachine = machineId
    let envName = params.daemon_env_name
    if (!envName && typeof machineId === 'string' && machineId.includes(':')) {
      const parts = machineId.split(':')
      targetMachine = parts[0]
      envName = parts[1]
    }
    if (!machineId || !envName) return Promise.reject(new NoDaemonError(machineId || '(unknown)', envName || '(unknown)'))
    const key = daemonAddress(targetMachine, envName)
    let dws = daemonConnections.get(key)
    if (!dws || dws.readyState !== 1) {
      if (isAgentLaunchOp(op) && daemonWelcomeSeenAt.has(key) && opts.waitForReconnect !== false) {
        try {
          await waitForDaemonReady(key, reconnectGraceMs)
          dws = daemonConnections.get(key)
        } catch {
          // Reconnect grace expired; fall through to the normal NoDaemonError path.
        }
      }
    }
    if (!dws || dws.readyState !== 1) {
      if (isAgentLaunchOp(op)) {
        logSpawnDaemonMiss(key, `sendDaemonRpcAttempt(${op})`, {
          hasWs: !!dws,
          readyState: dws?.readyState ?? 'missing',
          route: params.spawnRoute || 'unknown',
        })
      }
      return Promise.reject(new NoDaemonError(targetMachine, envName))
    }
    const id = opts.requestId || `rpc-${++rpcSeq}-${now().toString(36)}`
    // Per-attempt deadline is a caller-passed param (event-based default): control ops
    // wrapped in sendDaemonDurable pass a short per-attempt timeout so a stale-but-"open"
    // WS is abandoned quickly and retried on the fresh reconnect, rather than blocking
    // the full 10s each time.
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : null
    const promise = startWsRequest({
      pending: pendingRpcs,
      id,
      type: `rpc:${op}`,
      deadlineMs: timeoutMs,
      makeDeadlineError: () => new Error(`RPC timeout after ${timeoutMs}ms (op=${op}, daemon=${key})`),
      send: () => {
        try {
          dws.send(JSON.stringify({ type: 'rpc', id, op, ...params }))
          return true
        } catch (e) {
          pendingRpcs.get(id)?.reject(e)
          return true
        }
      },
    })
    const entry = pendingRpcs.get(id)
    if (entry) {
      entry.machine_id = targetMachine
      entry.env_name = envName
    }
    return promise
  }

  function rpcDaemonKey(machineId, params = {}) {
    if (params.daemon_env_name) return daemonAddress(machineId, params.daemon_env_name)
    if (typeof machineId === 'string' && machineId.includes(':')) {
      const [m, e] = machineId.split(':')
      return daemonAddress(m, e)
    }
    return machineId
  }

  // Event-based retry across reconnect for idempotent control ops. Retries only on
  // transient (reconnect-class) failures; op-level errors propagate immediately.
  async function durable(machineId, op, params = {}, {
    totalDeadlineMs = null,
    attemptTimeoutMs = null,
    requestId = null,
  } = {}) {
    const key = rpcDaemonKey(machineId, params)
    const stableRequestId = requestId || `rpc-${++rpcSeq}-${now().toString(36)}`
    const start = now()
    let lastErr = null
    while (true) {
      const remaining = Number.isFinite(totalDeadlineMs) ? totalDeadlineMs - (now() - start) : null
      if (remaining !== null && remaining <= 0) break
      const dws = daemonConnections.get(key)
      if (!dws || dws.readyState !== 1) {
        try { await waitForDaemonReady(key, remaining) } catch (e) { lastErr = e; break }
      }
      try {
        return await attempt(machineId, op, params, {
          requestId: stableRequestId,
          timeoutMs: Number.isFinite(attemptTimeoutMs)
            ? (remaining === null ? attemptTimeoutMs : Math.min(attemptTimeoutMs, Math.max(1, remaining)))
            : null,
        })
      } catch (e) {
        lastErr = e
        if (!isTransientRpcError(e)) throw e
        // A stale-but-"open" WS would re-hit the same dead socket; wait for a fresh
        // ready daemon (the close handler evicts the dead WS, the new hello notifies).
        const left = Number.isFinite(totalDeadlineMs) ? totalDeadlineMs - (now() - start) : null
        if (left !== null && left <= 0) break
        try { await waitForDaemonReady(key, left) } catch (we) { lastErr = we; break }
      }
    }
    // Exhausting the retry budget is not a verdict either -- nothing refused the
    // op, we stopped waiting. Carry a code so callers can tell that apart from a
    // daemon-reported failure, the same way NoDaemonError does.
    const exhausted = new Error(`RPC ${op} to ${key} gave no response within ${totalDeadlineMs}ms`)
    exhausted.code = 'RPC_DEADLINE'
    throw lastErr || exhausted
  }

  return { attempt, durable, rpcDaemonKey }
}
