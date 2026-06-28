import { isWorktreePath } from './daemon-identity.mjs'
import { resolveRepoIdentity } from './repo-identity.mjs'

function isServerWorktree(scriptPath, resolveIdentity = resolveRepoIdentity) {
  if (isWorktreePath(scriptPath)) return true
  try {
    return !!resolveIdentity(scriptPath).isWorktree
  } catch {
    return false
  }
}

// A worktree server is safe only when it is explicitly a dev/test server or it
// has its own project store and fleet DB. TLDA_SERVER is not a server-side data
// isolation signal; it only names a client target.
export function resolveServerIsolation({ env = {}, scriptPath = '', resolveIdentity = resolveRepoIdentity } = {}) {
  const devServer = !!env.TLDA_DEV_SERVER
  const isolatedData = !!env.PROJECTS_DIR && !!env.TLDA_FLEET_DB
  const isolated = devServer || isolatedData
  const isWorktree = isServerWorktree(scriptPath, resolveIdentity)

  if (isWorktree && !isolated) {
    return {
      devServer,
      isolatedData,
      isolated,
      isWorktree,
      refuseReason:
        'This server is running from a git worktree (' + scriptPath + ') with no ' +
        'server isolation signal. A worktree server must not start as the prod ' +
        'server because it would serve worktree code against the live config. Use ' +
        'tlda-dev serve/sandbox, or provide isolated PROJECTS_DIR and TLDA_FLEET_DB.',
    }
  }

  return { devServer, isolatedData, isolated, isWorktree, refuseReason: null }
}
