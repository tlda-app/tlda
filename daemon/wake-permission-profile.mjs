export function compileWakePermissionProfile({
  facts = {},
  wakeParams = {},
  loadDaemonLaunchConfig,
  readDaemonConfigForCwd,
  withDaemonModelAliases,
  compilePermissionGrant,
} = {}) {
  const cwd = facts.launchRecipe?.cwd || facts.processState?.cwd || process.cwd()
  const permissionGrant = wakeParams.permissionGrant
    || wakeParams.permission_grant
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
