import { daemonAddress } from '../../shared/agent-move-target.mjs'

export function createShadowMirrorRpcHandler({ readProject, sendDaemonEphemeral, daemonAddressFor = daemonAddress }) {
  return async function mirrorShadowViaDaemon({ name, hash, bundleBase64, sourceScope }) {
    const project = readProject(name)
    const machineId = project?.lastSourceMachineId || null
    const envName = project?.lastSourceEnvName || null
    if (!machineId || !envName) {
      throw new Error(`no source daemon recorded for ${name}`)
    }
    const result = await sendDaemonEphemeral(daemonAddressFor(machineId, envName), 'mirror-shadow-ref', {
      project: name,
      hash,
      bundleBase64,
      sourceScope,
    })
    return { ...result, machine_id: machineId, env_name: envName }
  }
}
