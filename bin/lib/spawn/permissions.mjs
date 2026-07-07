import fs from 'fs'
import os from 'os'
import path from 'path'
import { normalizeSpawnPolicy } from '../../../server/lib/spawn-policy.mjs'
import { repoRoot } from './identity.mjs'

const SANDBOX_POLICIES = new Set(['no-dev', 'cwd', 'tlda-projects', 'unsandboxed'])
const BUILTIN_POLICY_NAMES = new Set(['read', 'write', 'tlda-write', 'full'])
const DEFAULT_READ_ROOTS = []
const DEFAULT_OPTIONS = { network: false, git: 'read', artifacts: true }
const DEFAULT_TRUSTED_MCP_SERVERS = { tlda: { defaultToolsApprovalMode: 'approve' } }
// Built-in harness launch options are the visible defaults for fleet-managed
// harnesses. For Claude, the dev-channel flag is the strongly recommended
// default: it enables first-class fleet channel notifications. The alternative
// is tmux-only delivery, which is intentionally kept available but is janky
// (notably the tmux Enter inconsistency), so do not choose it unless you mean
// to accept that tradeoff.
const BUILTIN_HARNESS_OPTIONS = Object.freeze({
  claude: Object.freeze({
    '*': Object.freeze({
      required: Object.freeze([]),
      preferences: Object.freeze(['--dangerously-load-development-channels server:tlda']),
      controls: true,
    }),
  }),
  codex: Object.freeze({
    '*': Object.freeze({
      required: Object.freeze([]),
      preferences: Object.freeze([]),
      controls: true,
    }),
  }),
})

function isYoloFlag(flag) {
  return /--dangerously-skip-permissions\b/.test(flag)
    || /--dangerously-bypass-approvals-and-sandbox\b/.test(flag)
    || /--yolo\b/.test(flag)
    || /\bdanger-full-access\b/.test(flag)
}
const PLAYWRIGHT_CACHE_ROOT = path.join(os.homedir(), 'Library/Caches/ms-playwright')
const CHROME_FOR_TESTING_CRASHPAD_ROOT = path.join(os.homedir(), 'Library/Application Support/Google/Chrome for Testing/Crashpad')
const TLDA_PW_RUNTIME_ROOT = '/tmp/tlda-pw-runtime'
const TLDA_FENCE_TMP_ROOT = '/tmp/tlda-fence-env'

function expandUser(value) {
  const str = String(value || '')
  if (str === '~') return os.homedir()
  if (str.startsWith('~/')) return path.join(os.homedir(), str.slice(2))
  return str
}

function abs(value) {
  return path.resolve(expandUser(value))
}

function absOrPattern(value) {
  const expanded = expandUser(value)
  if (expanded === '**') return expanded
  if (/[*?[\]]/.test(expanded)) return path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
  return path.resolve(expanded)
}

function resolvePermissionZone(value, workspace) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (raw === '**') return raw
  if (raw === 'cwd') return path.join(workspace, '**')
  const expanded = expandUser(raw)
  if (path.isAbsolute(expanded)) return expanded
  return path.join(workspace, expanded)
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return { ...base }
  const out = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v
  }
  return out
}

function sandboxConfig(config = {}) {
  const cfg = config.agentSandbox
  if (cfg == null) return {}
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('agentSandbox must be an object')
  return cfg
}

function truthyEnv(value) {
  if (value == null || value === '') return false
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())
}

function permissionClassifierDisabled(config = {}, env = process.env) {
  return truthyEnv(env.TLDA_DISABLE_PERMISSION_CLASSIFIER)
    || sandboxConfig(config).disablePermissionsClassifier === true
}

function normalizeFlagList(value) {
  if (value == null) return []
  if (typeof value === 'string') return [value].filter(v => v.trim())
  if (!Array.isArray(value)) return []
  return value.map(v => String(v || '').trim()).filter(Boolean)
}

function harnessOptionRow(config = {}, harness, model) {
  const kind = String(harness || '').trim().toLowerCase()
  if (!kind) return null
  const configured = config?.harnessOptions?.[kind]
  const builtin = BUILTIN_HARNESS_OPTIONS[kind] || {}
  const builtinRow = builtin?.[model] || builtin?.['*'] || null
  const configuredRow = configured?.[model] || configured?.['*'] || null
  const row = configuredRow || builtinRow
  if (!row) return null
  const required = normalizeFlagList(row.required)
  const preferences = normalizeFlagList(row.preferences)
  const controls = configuredRow?.controls ?? builtinRow?.controls
  return {
    required,
    preferences,
    controls: controls !== false && (controls === true || required.length > 0),
  }
}

export function resolveHarnessLaunchOptions({ config = {}, harness, model } = {}) {
  const row = harnessOptionRow(config, harness, model) || { required: [], preferences: [], controls: false }
  const flags = [...row.required, ...row.preferences]
  const kind = String(harness || '').trim().toLowerCase()
  const hasYolo = flags.some(isYoloFlag)
  const nativeControls = kind === 'claude'
    ? !hasYolo
    : kind === 'codex'
      ? !hasYolo
      : row.controls && !hasYolo
  return {
    ...row,
    yolo: hasYolo,
    controls: !!nativeControls,
  }
}

export function assertLaunchHasSecurity({ leasePolicy, harnessOptions, acknowledgeNoSecurity = false, harness } = {}) {
  const hasFence = !!leasePolicy
  // Whether the classifier is bypassed is a property of the CONFIGURED harness flags
  // (a --dangerously-skip-permissions / --yolo the operator put in settings), surfaced
  // as harnessOptions.yolo — not a mode we computed. resolveHarnessLaunchOptions already
  // sets controls=false when a yolo flag is present, so bypassed controls never count.
  const permissionsBypassed = !!harnessOptions?.yolo
  const hasHarnessControls = !!harnessOptions?.controls
  if (hasFence || hasHarnessControls || acknowledgeNoSecurity) {
    return { hasFence, hasHarnessControls, permissionsBypassed, acknowledgedNoSecurity: !!acknowledgeNoSecurity }
  }
  throw new Error(`refusing to launch ${harness || 'agent'} with no security. This is the no-fence/no-harness-controls case; are you fucking sure? Pass --i-like-to-live-dangerously to acknowledge a wide-open launch.`)
}

function runnerFromConfig(cfg) {
  const runner = cfg.runner
  if (runner && typeof runner === 'object' && !Array.isArray(runner)) {
    if (!runner.command || typeof runner.command !== 'string') throw new Error('agentSandbox.runner.command is required')
    if (runner.args != null && !Array.isArray(runner.args)) throw new Error('agentSandbox.runner.args must be an array')
    return runner
  }
  // Default runner: the in-repo permissive seatbelt (allow-all except secrets +
  // scoped writes), NOT the old Go `fence` binary, which over-restricted — no `ps`,
  // no `~/.fly`, no git worktrees — the 2026-07-02 reason the fence was disabled.
  // It reads the lease from the `--settings` file (keeps the big JSON off the
  // command line, under the tmux length cap).
  const seatbelt = path.join(repoRoot(), 'bin', 'fence-seatbelt.mjs')
  if (!fs.existsSync(seatbelt)) throw new Error(`required seatbelt runner is missing: ${seatbelt}`)
  return { command: seatbelt, args: ['--settings', '{settings_file}', '--', 'zsh', '-lc', '{cmd}'] }
}

function configPathList(cfg, key, fallback = []) {
  let raw = cfg[key] ?? fallback
  if (typeof raw === 'string') raw = [raw]
  if (!Array.isArray(raw)) throw new Error(`agentSandbox.${key} must be a string or array`)
  return raw.filter((p) => typeof p === 'string' && p).map(abs)
}

function pathInside(child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c === p || c.startsWith(`${p}${path.sep}`)
}

function gitMetadataRoots(workspace) {
  const dotGit = path.join(workspace, '.git')
  const roots = []
  if (!fs.existsSync(dotGit)) return roots
  roots.push(dotGit)
  try {
    const stat = fs.statSync(dotGit)
    if (stat.isDirectory()) {
      roots.push(path.join(dotGit, '**'))
      return roots
    }
  } catch {
    return roots
  }
  let text = ''
  try {
    text = fs.readFileSync(dotGit, 'utf8')
  } catch {
    return roots
  }
  const match = text.match(/^gitdir:\s*(.+)\s*$/m)
  if (!match) return roots
  const gitDir = path.resolve(workspace, match[1].trim())
  roots.push(gitDir, path.join(gitDir, '**'))
  try {
    const commonDirText = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    if (commonDirText) {
      const commonDir = path.resolve(gitDir, commonDirText)
      roots.push(commonDir, path.join(commonDir, '**'))
    }
  } catch {
    // Worktrees have commondir; ordinary gitdir files may not.
  }
  return roots
}

function projectSourceDirs(config = {}) {
  const roots = []
  const projectsDir = path.join(repoRoot(), 'server', 'projects')
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      const projectFile = path.join(projectsDir, name, 'project.json')
      let parsed
      try {
        parsed = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
      } catch {
        continue
      }
      if (parsed?.sourceDir && fs.existsSync(abs(parsed.sourceDir))) roots.push(abs(parsed.sourceDir))
    }
  } catch {
    // Project-root discovery is best effort; explicit cwd policy still applies.
  }
  const cfg = sandboxConfig(config)
  let extra = cfg.extraProjectWriteRoots || []
  if (typeof extra === 'string') extra = [extra]
  if (Array.isArray(extra)) {
    for (const p of extra) {
      if (typeof p === 'string' && fs.existsSync(abs(p))) roots.push(abs(p))
    }
  }
  return [...new Set(roots)].sort()
}

export function sandboxMetadata(spawnPolicy, leasePolicy = null) {
  if (!spawnPolicy) return {}
  return {
    spawnPolicy: {
      ...(spawnPolicy.permission ? { permission: spawnPolicy.permission } : {}),
      ...(spawnPolicy.policy ? { policy: spawnPolicy.policy } : {}),
      ...(spawnPolicy.name ? { name: spawnPolicy.name } : {}),
    },
    ...(leasePolicy?.permission_set ? { permissionSet: leasePolicy.permission_set } : {}),
    ...(leasePolicy ? { sandbox: stripRunner(leasePolicy) } : {}),
  }
}

export function stripRunner(policy) {
  if (!policy) return null
  const { runner: _runner, ...rest } = policy
  return rest
}

function permissionZones(permissionSet, operation, effect) {
  const zones = permissionSet?.operations?.[operation]?.[effect] || []
  return Array.isArray(zones) ? zones.filter((zone) => typeof zone === 'string' && zone.trim()) : []
}

function resolvedPermissionZones(permissionSet, operation, effect, workspace) {
  return permissionZones(permissionSet, operation, effect)
    .map((zone) => resolvePermissionZone(zone, workspace))
    .filter(Boolean)
}

export function resolveLeasePolicy({ spawnPolicy, permissionSet = null, harness, model, cwd, config = {} } = {}) {
  if (!spawnPolicy) return { policyName: null, devTools: true, leasePolicy: null }
  const normalized = normalizeSpawnPolicy(spawnPolicy)
  const policyName = normalized.policy
  if (!SANDBOX_POLICIES.has(policyName)) throw new Error(`agentSandbox policy "${policyName}" is not valid`)
  const explicitPermissionSet = permissionSet && typeof permissionSet === 'object' && !Array.isArray(permissionSet)
  if (policyName === 'unsandboxed' && !explicitPermissionSet) return { policyName, devTools: true, leasePolicy: null }
  if (policyName === 'no-dev') return { policyName, devTools: false, leasePolicy: null }

  const workspace = abs(cwd || process.cwd())
  let writeRoots = []
  let matchedRoot = workspace
  if (explicitPermissionSet) {
    writeRoots = resolvedPermissionZones(permissionSet, 'write', 'allow', workspace)
    matchedRoot = workspace
  } else if (policyName === 'cwd') {
    writeRoots = [workspace]
  } else if (policyName === 'tlda-projects') {
    const roots = projectSourceDirs(config)
    matchedRoot = roots.find((root) => pathInside(workspace, root)) || null
    if (!matchedRoot) return { policyName, devTools: false, leasePolicy: null }
    writeRoots = roots
  }

  const cfg = sandboxConfig(config)
  const policyOptions = cfg.policyOptions && typeof cfg.policyOptions === 'object' ? cfg.policyOptions : {}
  const options = deepMerge(DEFAULT_OPTIONS, policyOptions[policyName] || {})
  const cap = normalized.permission
  if (explicitPermissionSet) {
    if (cap !== 'none' && normalized.network !== false) options.network = true
  } else if (cap === 'read') {
    writeRoots = []
  } else if (cap === 'write' || cap === 'tlda-write') {
    writeRoots = [
      ...writeRoots,
      path.join(os.homedir(), '.config', 'tlda'),
      CHROME_FOR_TESTING_CRASHPAD_ROOT,
      path.join(CHROME_FOR_TESTING_CRASHPAD_ROOT, '**'),
      TLDA_PW_RUNTIME_ROOT,
      TLDA_FENCE_TMP_ROOT,
    ]
    if (normalized.network !== false) options.network = true
  }
  if (cap !== 'none' && cap !== 'read') writeRoots = [...writeRoots, ...gitMetadataRoots(workspace)]
  const explicitReadRoots = explicitPermissionSet ? resolvedPermissionZones(permissionSet, 'read', 'allow', workspace) : []
  const readRoots = [...new Set([
    ...(explicitPermissionSet ? [] : [workspace]),
    ...(cap === 'none' ? [] : [PLAYWRIGHT_CACHE_ROOT, CHROME_FOR_TESTING_CRASHPAD_ROOT]),
    ...(cap === 'none' ? [] : configPathList(cfg, 'readRoots', DEFAULT_READ_ROOTS)),
    ...explicitReadRoots,
    ...writeRoots,
  ].map(absOrPattern))].sort()
  writeRoots = [...new Set(writeRoots.map(absOrPattern))].sort()
  const trusted = deepMerge(DEFAULT_TRUSTED_MCP_SERVERS, cfg.trustedMcpServers || {})
  return {
    policyName,
    devTools: true,
    matchedRoot,
    leasePolicy: {
      schema: 1,
      policy: policyName,
      permission: cap,
      harness,
      model: model || '',
      workspace,
      read_roots: readRoots,
      write_roots: writeRoots,
      deny_read_roots: explicitPermissionSet ? resolvedPermissionZones(permissionSet, 'read', 'deny', workspace) : [],
      deny_write_roots: explicitPermissionSet ? resolvedPermissionZones(permissionSet, 'write', 'deny', workspace) : [],
      ...(explicitPermissionSet ? { explicit_permission_set: true, permission_set: permissionSet } : {}),
      network: options.network !== false,
      git: options.git || 'read',
      artifacts: options.artifacts !== false,
      broad_write: writeRoots.includes('**') || writeRoots.includes('/'),
      machine_write: writeRoots.includes('**') || writeRoots.includes('/'),
      trusted_mcp_servers: trusted,
      runner: runnerFromConfig(cfg),
    },
  }
}

export function resolveLaunchPolicy({
  spawnPolicy,
  permissionSet = null,
  requestedPermission,
  harness,
  model,
  cwd,
  config = {},
  permissionMode,
  mode,
  explicitPolicy = false,
  acknowledgeNoSecurity = false,
  env = process.env,
} = {}) {
  // No hardcoded fallback: an un-granted agent has no fabricated policy. The policy
  // is whatever the grant resolved (project default ∩ spawner ∩ ceiling), passed in.
  const requestedPolicy = normalizeSpawnPolicy(
    spawnPolicy || requestedPermission || null,
    null,
  )
  // Apply the specified policy. No opt-in gate, no global off-switch, no silent
  // waiver — the agent's grant (already the intersection of the specified policy,
  // the spawner's authority, and the model ceiling) IS the fence, and it is
  // enforced as written. If there is a policy to apply, apply it.
  const useFence = !!requestedPolicy
  const leaseResolution = useFence
    ? resolveLeasePolicy({ spawnPolicy: requestedPolicy, permissionSet, harness, model, cwd, config })
    : { policyName: null, devTools: true, leasePolicy: null }
  // Permission mode is NOT derived from the grant or a permission level. The flag the
  // operator wants (--dangerously-skip-permissions, --permission-mode plan, …) is
  // configured in the daemon settings' harness options and passed straight through by
  // the harness adapter, exactly like the codex sandbox flag. The only mode honored
  // here is an explicit caller override or the emergency classifier-disable switch —
  // never one computed from what the agent was granted.
  const effectivePermissionMode = permissionClassifierDisabled(config, env)
    ? 'bypassPermissions'
    : (permissionMode ?? mode ?? undefined)
  const harnessOptions = resolveHarnessLaunchOptions({ config, harness, model })
  // Security comes from the applied grant (a fence) or the harness's own controls.
  // A genuinely wide-open launch (no fence, no controls) must be acknowledged
  // explicitly by the caller — no silent auto-waiver. Whether the classifier is
  // bypassed is read from the configured harness flags (harnessOptions.controls),
  // not from a derived mode.
  const launchSecurity = assertLaunchHasSecurity({
    leasePolicy: leaseResolution.leasePolicy,
    harnessOptions,
    acknowledgeNoSecurity,
    harness,
  })
  return {
    ...leaseResolution,
    harnessOptions,
    launchSecurity,
    spawnPolicy: requestedPolicy,
    permissionMode: effectivePermissionMode,
    classifierDisabled: permissionClassifierDisabled(config, env),
  }
}
