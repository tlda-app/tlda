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
export function createShadowMirrorRpcHandler({
  readProject,
  sendDaemonEphemeral,
  listDaemonKeys,
  daemonAddressFor = daemonAddress,
}) {
  return async function mirrorShadowViaDaemon({ name, hash, bundleBase64, sourceScope }) {
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
      const result = await sendDaemonEphemeral(key, 'mirror-shadow-ref', {
        project: name,
        hash,
        bundleBase64,
        sourceScope,
      })
      return { key, result }
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
