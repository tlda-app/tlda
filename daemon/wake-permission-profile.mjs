// The durable grant is the daemon permission ledger row. The launch recipe holds
// what was ASKED FOR at mint and what the spawner clamp allowed at that instant,
// and it is never rewritten — so reading it ahead of the ledger made every later
// wake re-apply the mint-time clamp, and no operator command could move an
// agent's permissions. `ensureAgentWakeGrant` already treats the ledger as the
// durable grant for `agent move`; this makes wake agree with it.
export function compileWakePermissionProfile({
  facts = {},
  wakeParams = {},
  ledgerGrant = null,
  loadDaemonLaunchConfig,
  readDaemonConfigForCwd,
  withDaemonModelAliases,
  compilePermissionGrant,
} = {}) {
  const cwd = facts.launchRecipe?.cwd || facts.processState?.cwd || process.cwd()
  const permissionGrant = wakeParams.permissionGrant
    || wakeParams.permission_grant
    || ledgerGrant
    || facts.launchRecipe?.permissionGrant
    || facts.processState?.permission_grant
  if (!permissionGrant) return { cwd, permissionGrant: null, permissionSet: null, config: null }
  const daemonConfig = readDaemonConfigForCwd(cwd)
  const config = withDaemonModelAliases(loadDaemonLaunchConfig(), daemonConfig)
  return {
    cwd,
    permissionGrant,
    permissionSet: compilePermissionGrant(config, permissionGrant, { cwd }),
    config,
  }
}
