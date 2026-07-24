import fs from 'fs'
import os from 'os'
import path from 'path'
import { harnessStateWriteRoots } from './harness-state-roots.mjs'
import { repoRoot } from './identity.mjs'

const DEFAULT_READ_ROOTS = []
const DEFAULT_OPTIONS = { network: false, git: 'read', artifacts: true }
const DEFAULT_TRUSTED_MCP_SERVERS = { tlda: { defaultToolsApprovalMode: 'approve' } }

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

function permissionSetList(value, operation, effect) {
  const list = value?.operations?.[operation]?.[effect]
  return Array.isArray(list) ? list : []
}

export function isIntentionalEmptyPermissionSet(value) {
  return String(value?.name || '').trim().toLowerCase() === 'none'
    || value?.compiledFrom === 'empty-permission-set'
}

// A grant that confers NO access at all: no readable and no writable zone. This
// is the single predicate for "no grant specified" at the spawn boundary
// (agent-launch.mjs) and in the launch-time lease build.
export function permissionSetConfersNothing(permissionSet) {
  return permissionSetList(permissionSet, 'read', 'allow').length === 0
    && permissionSetList(permissionSet, 'write', 'allow').length === 0
}

function validateExplicitPermissionSet(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  if (!value.operations || typeof value.operations !== 'object' || Array.isArray(value.operations)) {
    throw new Error('explicit permissionSet must contain operations')
  }
  for (const operation of ['read', 'write', 'spawn']) {
    const row = value.operations[operation]
    if (row == null) continue
    if (typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`explicit permissionSet operations.${operation} must be an object`)
    }
    for (const effect of ['allow', 'deny']) {
      if (row[effect] != null && !Array.isArray(row[effect])) {
        throw new Error(`explicit permissionSet operations.${operation}.${effect} must be an array`)
      }
    }
  }
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

function truthyEnv(value) {
  if (value == null || value === '') return false
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase())
}

function permissionClassifierDisabled(config = {}, env = process.env) {
  return truthyEnv(env.TLDA_DISABLE_PERMISSION_CLASSIFIER)
}

function normalizeFlagList(value) {
  if (value == null) return []
  if (typeof value === 'string') return [value].filter(v => v.trim())
  if (!Array.isArray(value)) return []
  return value.map(v => String(v || '').trim()).filter(Boolean)
}

function normalizeHarnessOptionRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const required = normalizeFlagList(row.required)
  const preferences = normalizeFlagList(row.preferences)
  return {
    required,
    preferences,
    controls: row.controls !== false && (row.controls === true || required.length > 0),
  }
}

export function resolveHarnessLaunchOptions({ harness, harnessOptions = null } = {}) {
  const row = normalizeHarnessOptionRow(harnessOptions) || { required: [], preferences: [], controls: false }
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

function defaultRunner() {
  // The runner is implementation mechanics, not daemon config: there is one
  // supported seatbelt wrapper unless product requirements add another.
  const seatbelt = path.join(repoRoot(), 'bin', 'fence-seatbelt.mjs')
  if (!fs.existsSync(seatbelt)) throw new Error(`required seatbelt runner is missing: ${seatbelt}`)
  return { command: seatbelt, args: ['--settings', '{settings_file}', '--', 'zsh', '-lc', '{cmd}'] }
}

function configPathList(value = []) {
  const raw = typeof value === 'string' ? [value] : value
  if (!Array.isArray(raw)) throw new Error('configured path list must be a string or array')
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
  return [...new Set(roots)].sort()
}

export function permissionMetadata(permissionGrant) {
  if (!permissionGrant) return {}
  return { permissionGrant }
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

export function resolveLeasePolicy({ permissionGrant, permissionSet = null, harness, model, cwd, config = {}, env = process.env } = {}) {
  if (!permissionGrant) throw new Error('resolved permission grant is required')
  const explicitPermissionSet = permissionSet && typeof permissionSet === 'object' && !Array.isArray(permissionSet)
  if (explicitPermissionSet) validateExplicitPermissionSet(permissionSet)
  if (!explicitPermissionSet) throw new Error('compiled permission set is required')

  const workspace = abs(cwd || process.cwd())
  let writeRoots = resolvedPermissionZones(permissionSet, 'write', 'allow', workspace)
  const matchedRoot = workspace

  const options = { ...DEFAULT_OPTIONS }
  const networkOff = permissionSet.network === false
  const grantsWrite = permissionSetList(permissionSet, 'write', 'allow').length > 0
  const grantsAnything = grantsWrite || permissionSetList(permissionSet, 'read', 'allow').length > 0
  if (explicitPermissionSet && !grantsAnything && !isIntentionalEmptyPermissionSet(permissionSet)) {
    throw new Error(`explicit permissionSet "${permissionSet.name || '(unnamed)'}" grants no read/write zones`)
  }
  writeRoots = [...writeRoots, ...harnessStateWriteRoots(env)]
  if (grantsWrite) writeRoots = [...writeRoots, ...gitMetadataRoots(workspace)]
  if (grantsAnything && !networkOff) options.network = true
  const explicitReadRoots = resolvedPermissionZones(permissionSet, 'read', 'allow', workspace)
  const readRoots = [...new Set([
    ...(grantsAnything ? [PLAYWRIGHT_CACHE_ROOT, CHROME_FOR_TESTING_CRASHPAD_ROOT] : []),
    ...(grantsAnything ? configPathList(DEFAULT_READ_ROOTS) : []),
    ...explicitReadRoots,
    ...writeRoots,
  ].map(absOrPattern))].sort()
  writeRoots = [...new Set(writeRoots.map(absOrPattern))].sort()
  const trusted = deepMerge(DEFAULT_TRUSTED_MCP_SERVERS, {})
  return {
    devTools: true,
    matchedRoot,
    leasePolicy: {
      schema: 1,
      // An empty grant confers nothing (no read, no write) — the seatbelt default-denies
      // and adds no agent roots.
      empty: !grantsAnything,
      harness,
      model: model || '',
      permission_grant: permissionGrant,
      workspace,
      read_roots: readRoots,
      write_roots: writeRoots,
      deny_read_roots: resolvedPermissionZones(permissionSet, 'read', 'deny', workspace),
      deny_write_roots: resolvedPermissionZones(permissionSet, 'write', 'deny', workspace),
      network: options.network !== false,
      git: options.git || 'read',
      artifacts: options.artifacts !== false,
      broad_write: writeRoots.includes('**') || writeRoots.includes('/'),
      machine_write: writeRoots.includes('**') || writeRoots.includes('/'),
      trusted_mcp_servers: trusted,
      runner: defaultRunner(),
    },
  }
}

export function resolveLaunchPolicy({
  permissionGrant,
  permissionSet = null,
  harness,
  model,
  cwd,
  config = {},
  permissionMode,
  mode,
  explicitPermissionRequest = false,
  acknowledgeNoSecurity = false,
  harnessOptions: resolvedHarnessOptions = null,
  env = process.env,
} = {}) {
  if (!permissionGrant) throw new Error('resolved daemon permission grant is required')
  const leaseResolution = resolveLeasePolicy({ permissionGrant, permissionSet, harness, model, cwd, config, env })
  // Permission mode is NOT derived from the grant. The flag the
  // operator wants (--dangerously-skip-permissions, --permission-mode plan, …) is
  // configured in the daemon settings' harness options and passed straight through by
  // the harness adapter, exactly like the codex sandbox flag. The only mode honored
  // here is an explicit caller override or the emergency classifier-disable switch —
  // never one computed from what the agent was granted.
  const effectivePermissionMode = permissionClassifierDisabled(config, env)
    ? 'bypassPermissions'
    : (permissionMode ?? mode ?? undefined)
  let harnessOptions = resolveHarnessLaunchOptions({ harness, harnessOptions: resolvedHarnessOptions })
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
    permissionGrant,
    permissionMode: effectivePermissionMode,
    classifierDisabled: permissionClassifierDisabled(config, env),
  }
}
