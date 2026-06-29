import fs from 'fs'
import os from 'os'
import path from 'path'
import { normalizeSpawnPolicy, projectCapabilityToMode, resolveProjectProfileName } from '../../../server/lib/spawn-policy.mjs'
import { repoRoot } from './identity.mjs'

const SANDBOX_POLICIES = new Set(['no-dev', 'cwd', 'app-dev', 'tlda-projects', 'unsandboxed'])
const BUILTIN_POLICY_NAMES = new Set(['read', 'write', 'tlda-write', 'full'])
const FENCE_GLOBALLY_DISABLED = true
const DEFAULT_READ_ROOTS = ['~/work']
const DEFAULT_OPTIONS = { network: false, git: 'write', artifacts: true }
const DEFAULT_TRUSTED_MCP_SERVERS = { tlda: { defaultToolsApprovalMode: 'approve' } }
const PLAYWRIGHT_CACHE_ROOT = path.join(os.homedir(), 'Library/Caches/ms-playwright')
const TLDA_FENCE_TMP_ROOT = '/tmp/tlda-fence-env'
const WORK_ROOT = path.join(os.homedir(), 'work')
const GUIDANCE_ROOT = path.join(WORK_ROOT, 'dot-claude')

function expandUser(value) {
  const str = String(value || '')
  if (str === '~') return os.homedir()
  if (str.startsWith('~/')) return path.join(os.homedir(), str.slice(2))
  return str
}

function abs(value) {
  return path.resolve(expandUser(value))
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

function isExplicitPolicy(normalized, explicitPolicy = false) {
  return !!(explicitPolicy || (normalized?.name && !BUILTIN_POLICY_NAMES.has(normalized.name)))
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

function projectSourceDirs(config = {}) {
  const roots = []
  const projectsDir = path.join(repoRoot(), 'server', 'projects')
  const cfg = sandboxConfig(config)
  let allowedProfiles = cfg.tldaProjectProfiles ?? ['math-projects']
  if (typeof allowedProfiles === 'string') allowedProfiles = [allowedProfiles]
  const allowedProfileSet = Array.isArray(allowedProfiles)
    ? new Set(allowedProfiles.map((p) => String(p || '').trim().toLowerCase()).filter(Boolean))
    : null
  try {
    for (const name of fs.readdirSync(projectsDir)) {
      const projectFile = path.join(projectsDir, name, 'project.json')
      let parsed
      try {
        parsed = JSON.parse(fs.readFileSync(projectFile, 'utf8'))
      } catch {
        continue
      }
      if (!parsed?.sourceDir || !fs.existsSync(abs(parsed.sourceDir))) continue
      if (allowedProfileSet) {
        const profile = resolveProjectProfileName(config, { doc: parsed.name || name, project: parsed, cwd: parsed.sourceDir })
        if (!allowedProfileSet.has(profile)) continue
      }
      roots.push(abs(parsed.sourceDir))
    }
  } catch {
    // Project-root discovery is best effort; explicit cwd policy still applies.
  }
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
  const capability = spawnPolicy?.capability === 'read' ? 'write' : spawnPolicy?.capability
  if (capability === 'full') return { sandboxMode: 'danger-full-access', workspaceWriteConfigArgs: [], networkAccess: false }
  const writableRoots = [
    path.join(os.homedir(), '.config', 'tlda'),
    path.join(cwd, '.git'),
  ]
  return { sandboxMode: 'workspace-write', writableRoots, networkAccess: spawnPolicy.network !== false }
}

export function resolveLeasePolicy({ spawnPolicy, harness, model, cwd, config = {} } = {}) {
  if (!spawnPolicy) return { policyName: null, devTools: true, leasePolicy: null }
  const normalized = normalizeSpawnPolicy(spawnPolicy)
  const policyName = normalized.policy
  if (!SANDBOX_POLICIES.has(policyName)) throw new Error(`agentSandbox policy "${policyName}" is not valid`)
  const machineWrite = normalized.capability === 'full' || policyName === 'unsandboxed'
  if (policyName === 'no-dev') return { policyName, devTools: false, leasePolicy: null }

  const workspace = abs(cwd || process.cwd())
  let writeRoots = []
  let matchedRoot = workspace
  if (policyName === 'unsandboxed') {
    writeRoots = [WORK_ROOT, GUIDANCE_ROOT]
    matchedRoot = WORK_ROOT
  } else if (policyName === 'app-dev') {
    writeRoots = [WORK_ROOT]
  } else if (policyName === 'cwd') {
    writeRoots = [workspace]
  } else if (policyName === 'tlda-projects') {
    const roots = projectSourceDirs(config)
    matchedRoot = roots.find((root) => pathInside(workspace, root)) || null
    if (!matchedRoot) return { policyName, devTools: false, leasePolicy: null }
    writeRoots = [...roots, GUIDANCE_ROOT]
  }

  const cfg = sandboxConfig(config)
  const policyOptions = cfg.policyOptions && typeof cfg.policyOptions === 'object' ? cfg.policyOptions : {}
  const options = deepMerge(DEFAULT_OPTIONS, policyOptions[policyName] || {})
  const cap = normalized.capability === 'read' ? 'write' : normalized.capability
  if (cap === 'write' || cap === 'tlda-write' || cap === 'full') {
    writeRoots = [...writeRoots, path.join(os.homedir(), '.config', 'tlda'), PLAYWRIGHT_CACHE_ROOT, TLDA_FENCE_TMP_ROOT]
    if (!machineWrite) writeRoots.push(path.join(workspace, '.git'))
    if (normalized.network !== false) options.network = true
  }
  const readRoots = [...new Set([workspace, ...configPathList(cfg, 'readRoots', DEFAULT_READ_ROOTS), ...writeRoots].map(abs))].sort()
  writeRoots = [...new Set(writeRoots.map(abs))].sort()
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
      network: options.network !== false,
      git: options.git || 'write',
      broad_write: options.broadWrite === true,
      machine_write: machineWrite || options.machineWrite === true,
      artifacts: options.artifacts !== false,
      trusted_mcp_servers: trusted,
      runner: runnerFromConfig(cfg),
    },
  }
}

export function resolveLaunchPolicy({
  spawnPolicy,
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
  const requestedNeedsFence = !!requestedPolicy && requestedPolicy.policy !== 'no-dev'
  const useFence = !!requestedPolicy && (
    requestedNeedsFence
    || !FENCE_GLOBALLY_DISABLED
    || isExplicitPolicy(requestedPolicy, explicitPolicy)
  )
  const leaseResolution = useFence
    ? resolveLeasePolicy({ spawnPolicy: requestedPolicy, harness, model, cwd, config })
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
    fenceGloballyDisabled: FENCE_GLOBALLY_DISABLED,
  }
}
