import fs from 'fs'
import os from 'os'
import path from 'path'
import { normalizeSpawnPolicy, projectCapabilityToMode } from '../../../server/lib/spawn-policy.mjs'
import { repoRoot } from './identity.mjs'

const SANDBOX_POLICIES = new Set(['no-dev', 'cwd', 'tlda-projects', 'unsandboxed'])
const BUILTIN_POLICY_NAMES = new Set(['read', 'write', 'tlda-write', 'full'])
// Break-glass switch only. The durable target is a pw-capable fence: broad
// safe writes work, while secret/chat-db/destructive paths stay denied.
const FENCE_TEMPORARILY_DISABLED = true
const DEFAULT_READ_ROOTS = []
const DEFAULT_OPTIONS = { network: false, git: 'read', artifacts: true }
const DEFAULT_TRUSTED_MCP_SERVERS = { tlda: { defaultToolsApprovalMode: 'approve' } }
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

function resolvePrivilegeZone(value, workspace) {
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

function runnerFromConfig(cfg) {
  const runner = cfg.runner
  if (runner && typeof runner === 'object' && !Array.isArray(runner)) {
    if (!runner.command || typeof runner.command !== 'string') throw new Error('agentSandbox.runner.command is required')
    if (runner.args != null && !Array.isArray(runner.args)) throw new Error('agentSandbox.runner.args must be an array')
    return runner
  }
  const localFence = path.join(os.homedir(), '.claude', 'bin', 'fence')
  if (!fs.existsSync(localFence)) throw new Error(`required fence runner is missing: ${localFence}`)
  return { command: localFence }
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
      ...(spawnPolicy.capability ? { capability: spawnPolicy.capability } : {}),
      ...(spawnPolicy.policy ? { policy: spawnPolicy.policy } : {}),
      ...(spawnPolicy.name ? { name: spawnPolicy.name } : {}),
    },
    ...(leasePolicy?.privilege_set ? { privilegeSet: leasePolicy.privilege_set } : {}),
    ...(leasePolicy ? { sandbox: stripRunner(leasePolicy) } : {}),
  }
}

export function stripRunner(policy) {
  if (!policy) return null
  const { runner: _runner, ...rest } = policy
  return rest
}

export function codexSandboxProjection(spawnPolicy, cwd, { fenced = false } = {}) {
  if (fenced) return { sandboxMode: 'danger-full-access', workspaceWriteConfigArgs: [], networkAccess: false }
  return { sandboxMode: 'danger-full-access', workspaceWriteConfigArgs: [], networkAccess: false }
}

function privilegeZones(privilegeSet, operation, effect) {
  const zones = privilegeSet?.operations?.[operation]?.[effect] || []
  return Array.isArray(zones) ? zones.filter((zone) => typeof zone === 'string' && zone.trim()) : []
}

function resolvedPrivilegeZones(privilegeSet, operation, effect, workspace) {
  return privilegeZones(privilegeSet, operation, effect)
    .map((zone) => resolvePrivilegeZone(zone, workspace))
    .filter(Boolean)
}

export function resolveLeasePolicy({ spawnPolicy, privilegeSet = null, harness, model, cwd, config = {} } = {}) {
  if (!spawnPolicy) return { policyName: null, devTools: true, leasePolicy: null }
  const normalized = normalizeSpawnPolicy(spawnPolicy)
  const policyName = normalized.policy
  if (!SANDBOX_POLICIES.has(policyName)) throw new Error(`agentSandbox policy "${policyName}" is not valid`)
  const explicitPrivilegeSet = privilegeSet && typeof privilegeSet === 'object' && !Array.isArray(privilegeSet)
  if (policyName === 'unsandboxed' && !explicitPrivilegeSet) return { policyName, devTools: true, leasePolicy: null }
  if (policyName === 'no-dev') return { policyName, devTools: false, leasePolicy: null }

  const workspace = abs(cwd || process.cwd())
  let writeRoots = []
  let matchedRoot = workspace
  if (explicitPrivilegeSet) {
    writeRoots = resolvedPrivilegeZones(privilegeSet, 'write', 'allow', workspace)
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
  const cap = normalized.capability
  if (explicitPrivilegeSet) {
    if (normalized.network !== false) options.network = true
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
  const explicitReadRoots = explicitPrivilegeSet ? resolvedPrivilegeZones(privilegeSet, 'read', 'allow', workspace) : []
  const readRoots = [...new Set([
    ...(explicitPrivilegeSet ? [] : [workspace]),
    PLAYWRIGHT_CACHE_ROOT,
    CHROME_FOR_TESTING_CRASHPAD_ROOT,
    ...configPathList(cfg, 'readRoots', DEFAULT_READ_ROOTS),
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
      harness,
      model: model || '',
      workspace,
      read_roots: readRoots,
      write_roots: writeRoots,
      deny_read_roots: explicitPrivilegeSet ? resolvedPrivilegeZones(privilegeSet, 'read', 'deny', workspace) : [],
      deny_write_roots: explicitPrivilegeSet ? resolvedPrivilegeZones(privilegeSet, 'write', 'deny', workspace) : [],
      ...(explicitPrivilegeSet ? { explicit_privilege_set: true, privilege_set: privilegeSet } : {}),
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
  privilegeSet = null,
  requestedCapability,
  harness,
  model,
  cwd,
  config = {},
  permissionMode,
  mode,
  explicitPolicy = false,
  env = process.env,
} = {}) {
  const requestedPolicy = normalizeSpawnPolicy(
    spawnPolicy || requestedCapability || (harness === 'codex' ? 'write' : null),
    null,
  )
  const useFence = !!requestedPolicy && (!FENCE_TEMPORARILY_DISABLED || explicitPolicy || !!privilegeSet)
  const leaseResolution = useFence
    ? resolveLeasePolicy({ spawnPolicy: requestedPolicy, privilegeSet, harness, model, cwd, config })
    : { policyName: requestedPolicy ? 'unsandboxed' : null, devTools: true, leasePolicy: null }
  const explicitMode = permissionMode ?? mode
  const effectivePermissionMode = permissionClassifierDisabled(config, env)
    ? 'bypassPermissions'
    : (explicitMode ?? (leaseResolution.leasePolicy
        ? 'bypassPermissions'
        : (requestedPolicy?.capability ? projectCapabilityToMode(requestedPolicy.capability) : undefined)))
  return {
    ...leaseResolution,
    spawnPolicy: requestedPolicy,
    permissionMode: effectivePermissionMode,
    classifierDisabled: permissionClassifierDisabled(config, env),
    fenceTemporarilyDisabled: FENCE_TEMPORARILY_DISABLED,
    fenceGloballyDisabled: FENCE_TEMPORARILY_DISABLED,
  }
}
