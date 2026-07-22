/**
 * Focused test for B6: withDaemonModelAliases must NOT return the legacy config
 * (config.json) spawn policy when the daemon config has no models/profiles.
 * config.json is retired — a spawn grant derives ONLY from daemon.yaml.
 *
 * Run:  node agent-launch/permission-ledger.test.mjs   (exits non-zero on failure)
 */
import { withDaemonModelAliases } from './permission-ledger.mjs'

const failures = []
function check(name, cond) {
  console.log((cond ? '  ok  ' : '  FAIL ') + name)
  if (!cond) failures.push(name)
}

// A legacy config.json object carrying a spawn policy + model aliases.
const legacy = {
  spawnPolicy: {
    permissionProfiles: { LEGACY: { fly: true } },
    defaultProfile: 'LEGACY',
    fenceEnabled: false,
  },
  models: { 'legacy-alias': 'claude-x' },
}

// --- B6: empty daemon config → NO legacy leak ---
const empty = withDaemonModelAliases(legacy, {})
check('empty daemon: does not return the legacy object',
      empty !== legacy)
check('empty daemon: no legacy permission profiles leak through',
      !empty?.spawnPolicy?.permissionProfiles || !('LEGACY' in empty.spawnPolicy.permissionProfiles))
check('empty daemon: no legacy defaultProfile leaks through',
      !empty?.spawnPolicy?.defaultProfile)
check('empty daemon: no legacy model aliases leak through',
      !empty?.models || !('legacy-alias' in empty.models))
check('empty daemon: returns an explicit empty spawnPolicy',
      empty && empty.spawnPolicy && Object.keys(empty.spawnPolicy).length === 0)

// --- positive: daemon profiles present → daemon's policy, still no legacy ---
const withProfiles = withDaemonModelAliases(legacy, {
  profiles: { reviewer: { fly: false, read: true } },
  default: 'reviewer',
})
check('daemon profiles present: daemon profile is applied',
      !!withProfiles?.spawnPolicy?.permissionProfiles?.reviewer)
check('daemon profiles present: legacy profile still absent',
      !('LEGACY' in (withProfiles.spawnPolicy.permissionProfiles || {})))
check('daemon profiles present: fenceEnabled comes from daemon (true)',
      withProfiles.spawnPolicy.fenceEnabled === true)

if (failures.length) {
  console.log(`\n${failures.length} FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nall permission-ledger (B6) tests passed')
