import { daemonAddress } from '../../shared/agent-move-target.mjs'

// Mirror a built version back to the machines holding this project.
//
// This used to go to `project.lastSourceMachineId` — one machine, overwritten on
// every push. So with two people editing, only whoever pushed last received the
// server's version and everyone else silently fell behind. The spec is "if it's
// edited on any connected machine, it goes to you", so it goes to all of them.
//
// Every connected daemon is offered the mirror. A daemon that does not watch the
// project, or whose sourceDir is not a git repo, rejects it itself — that is not
// an error here, it is how a machine says "not mine". The mirror succeeds if any
// daemon took it, and reports the ones that didn't so a machine that is
// genuinely stuck stays visible rather than being averaged away.
// How long one daemon may take to answer a mirror before it is treated as not
// having answered. The fan-out below waits for every key, and the sender it uses
// is the durable one — chosen deliberately to retry a WS flap rather than throw a
// short timeout. That combination has no upper bound: a key that never answers
// never settles, so the mirror never returns, so the build worker awaiting it
// never exits, so `_inFlight` never releases and every later build is answered
// `already-building`. On 2026-08-17 that held Skip's render five hours stale and
// survived killing the worker, restarting the daemon, and restarting the server.
//
// A per-key deadline does not weaken the durable sender's retrying — the send
// keeps going, and being idempotent (same hash → same ref) it is safe if it
// lands late. It only stops the fan-out waiting on it, which is the difference
// between one machine missing a mirror and every build stopping.
// Must exceed the durable sender's TOTAL deadline (150s in unified-server.mjs),
// or this cuts off the retries it is supposed to be a backstop for. See the
// budget table there: this is the second-outermost layer, and the outermost is
// the build worker's callParent deadline.
export const MIRROR_KEY_TIMEOUT_MS = Number(process.env.TLDA_MIRROR_KEY_TIMEOUT_MS) || 180000

export function createShadowMirrorRpcHandler({
  readProject,
  sendDaemonEphemeral,
  listDaemonKeys,
  daemonAddressFor = daemonAddress,
  keyTimeoutMs = MIRROR_KEY_TIMEOUT_MS,
}) {
  return async function mirrorShadowViaDaemon({ name, hash, bundleBase64, sourceScope, sourceRevision, acceptSeq, refusedRevision = null }) {
    const project = await readProject(name)
    const lastKey = project?.lastSourceMachineId && project?.lastSourceEnvName
      ? daemonAddressFor(project.lastSourceMachineId, project.lastSourceEnvName)
      : null
    const keys = [...new Set([...(listDaemonKeys?.() || []), ...(lastKey ? [lastKey] : [])])]
    if (keys.length === 0) {
      return {
        ok: true,
        machine_id: null,
        env_name: null,
        mirrored: [],
        declined: [],
      }
    }

    const settled = await Promise.allSettled(keys.map(async (key) => {
      const send = sendDaemonEphemeral(key, 'mirror-shadow-ref', {
        project: name,
        hash,
        // Forwarded explicitly. This function rebuilds the params object field
        // by field rather than spreading, so anything added at either end and
        // not added HERE is produced by the server, consumed by the daemon, and
        // silently dropped in between — which is what happened to this field on
        // its first day.
        refusedRevision,
        bundleBase64,
        sourceScope,
        sourceRevision,
        acceptSeq,
      })
      // Race the send against its deadline rather than aborting it. The send is
      // durable and idempotent, so letting it continue costs nothing and may
      // still deliver; what must not continue is this fan-out's wait on it.
      // Deliberately not unref'd. An unref'd deadline does not hold the event loop
      // open, so if the only outstanding work IS the hung send, the timer never
      // fires and the deadline silently does nothing — which is the exact failure
      // it exists to prevent. It is always cleared in the `finally` below, so it
      // cannot keep a process alive past its purpose either.
      let timer
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`daemon ${key} did not answer the mirror within ${keyTimeoutMs}ms`)),
          keyTimeoutMs,
        )
      })
      try {
        return { key, result: await Promise.race([send, deadline]) }
      } finally {
        clearTimeout(timer)
      }
    }))

    const mirrored = []
    const declined = []
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]
      if (outcome.status === 'fulfilled' && outcome.value.result?.ok !== false) {
        mirrored.push({ key: keys[i], ...outcome.value.result })
      } else {
        const reason = outcome.status === 'rejected'
          ? (outcome.reason?.message || String(outcome.reason))
          : (outcome.value.result?.error || 'declined')
        declined.push({ key: keys[i], reason })
      }
    }

    if (mirrored.length === 0) {
      throw new Error(`no daemon accepted the mirror for ${name}: ${declined.map(d => `${d.key} (${d.reason})`).join(', ')}`)
    }
    const primary = mirrored.find(entry => entry.key === lastKey) || mirrored[0]
    return {
      ...primary,
      machine_id: primary.machine_id ?? primary.key?.split(':')[0] ?? null,
      env_name: primary.env_name ?? primary.key?.split(':')[1] ?? null,
      mirrored: mirrored.map(entry => entry.key),
      declined,
    }
  }
}
