import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { modelFamily as sharedModelFamily, modelTrustTier as sharedModelTrustTier } from '../../shared/harness.ts'

// Skip's ONE permission vocabulary — the coarse permission NAMES. This is the
// only permission vocabulary tlda owns; there is NO machine vocabulary
// (workspace-*, *-no-net, full-access) on any tlda surface. These names are a
// COARSE LABEL for a region set, not a rank ladder: the real authority is the
// region-set intersection (intersectPermissionSets); the name is derived FROM
// the region set (policyForPermissionSet) for display and for the sandbox-region
// selection downstream. The filesystem REGION each name maps to is PART OF THE
// NAME (tlda-write = write across all tlda projects), not a second axis. "no-net"
// is not a name — net is always on (Skip: "literally every type of agent should
// be able to use the Internet"); it survives only as a never-typed
// `network:false` modifier. The single foreign string that survives is Codex's
// own sandbox API value, mapped at the fleet-spawn boundary, not here.
const PERMISSION_NAMES = new Set(['none', 'read', 'write', 'tlda-write', 'full'])

// The fence directory-region each coarse name maps to. These region names
// (cwd / tlda-projects / unsandboxed) are the FENCE's own vocabulary for
// directory scopes — not a second permission vocabulary — and follow the name.
// This is a flat label→region dictionary, NOT an ordered ladder: nothing here
// ranks or compares names. It exists only so normalizeSpawnPolicy can emit a
// coherent `.policy` field once policyForPermissionSet has named the region set.
const REGION_FOR_PERMISSION = {
  none: 'cwd',
  read: 'cwd',
  write: 'cwd',
  'tlda-write': 'tlda-projects',
  full: 'unsandboxed',
}

export const DEFAULT_AGENT_PERMISSION = 'write'
export const ROOT_PERMISSION = 'full'

// Interpret an old-vocabulary (permission, region) pair into a four-name rung —
// the ONE place legacy machine words are read. This is for PERSISTED data and
// the operator's fence.json (which may still hold old words); it is NOT a
// user-facing alias. The region disambiguates the legacy write / tlda-write
// split (both were `workspace-write`). `workspace-write-no-net` → write: net is
// now always on, so old no-net rows correctly gain net. Returns a rung or null.
// Removable once every live agent and fence.json use the current names.
function legacyRung(permission, region) {
  const raw = String(permission ?? '').trim().toLowerCase()
  if (PERMISSION_NAMES.has(raw)) return raw // already a coarse permission name
  const reg = region == null ? null : String(region).trim().toLowerCase()
  if (raw === 'read-only') return 'read'
  if (raw === 'full-access') return 'full'
  if (raw === 'workspace-write' || raw === 'workspace-write+net' || raw === 'workspace-write-no-net') {
    return reg === 'tlda-projects' ? 'tlda-write' : 'write'
  }
  return null
}

// The named fence configurations are the BUILT-IN DEFAULTS. The operator
// owns them and may override or add to them in the fence config file
// (~/.config/tlda/fence.json, key "policies"; or $TLDA_FENCE_CONFIG). That FILE
// is the source of truth — this map is only the fallback when it is absent, so
// behavior with no file is identical to before.
const BUILTIN_SPAWN_POLICY_OPTIONS = {
  read: { permission: 'read', policy: 'cwd', category: 'write-scope' },
  write: { permission: 'write', policy: 'cwd', category: 'write-scope' },
  'tlda-write': { permission: 'tlda-write', policy: 'tlda-projects', category: 'write-scope' },
  full: { permission: 'full', policy: 'unsandboxed', category: 'write-scope' },
}

function loadFenceConfigPolicies() {
  const path = process.env.TLDA_FENCE_CONFIG || join(homedir(), '.config', 'tlda', 'fence.json')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return {} // absent → built-in defaults, the normal case
    // Present but unreadable is a real misconfiguration; surface it, don't bury it.
    process.stderr.write(`[spawn-policy] cannot read fence config ${path}: ${err.message}\n`)
    return {}
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    process.stderr.write(`[spawn-policy] fence config ${path} is not valid JSON: ${err.message}\n`)
    return {}
  }
  const policies = parsed && typeof parsed === 'object' ? parsed.policies : null
  return policies && typeof policies === 'object' && !Array.isArray(policies) ? policies : {}
}

function buildSpawnPolicyOptions() {
  const merged = {}
  for (const [name, def] of Object.entries(BUILTIN_SPAWN_POLICY_OPTIONS)) merged[name] = { ...def }
  // Valid fence region names — the values REGION_FOR_PERMISSION can produce plus
  // the regions the fence's own sandbox resolver (permissions.mjs SANDBOX_POLICIES)
  // accepts as write-scope policies. 'no-dev' is a valid sandbox policy but not
  // a write-scope region, so it is excluded here.
  const VALID_REGIONS = new Set(['cwd', 'tlda-projects', 'unsandboxed'])
  for (const [name, def] of Object.entries(loadFenceConfigPolicies())) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue
    // The operator's fence.json may still describe a policy in OLD vocabulary
    // (permission `full-access`, writeScope `unsandboxed`). Normalize it to a
    // four-name rung so a stale config can't reintroduce machine vocabulary.
    const cap = legacyRung(def.permission, def.policy ?? def.writeScope)
      || (PERMISSION_NAMES.has(name) ? name : merged[name]?.permission)
    if (!cap || !PERMISSION_NAMES.has(cap)) continue
    // Use the operator's configured region when it is a recognized fence region,
    // falling back to the name-derived default. This fixes the "config thrown
    // out" bug where every policy was force-derived from REGION_FOR_PERMISSION[cap]
    // regardless of what the operator wrote in fence.json.
    const operatorRegion = (def.policy ?? def.writeScope ?? '')
    const region = VALID_REGIONS.has(operatorRegion) ? operatorRegion : REGION_FOR_PERMISSION[cap]
    merged[name] = { permission: cap, policy: region, category: 'write-scope' }
  }
  return merged
}

export const SPAWN_POLICY_OPTIONS = buildSpawnPolicyOptions()

export function resolveSpawnPolicyOption(value) {
  if (value == null || value === '') return null
  const raw = String(value).trim().toLowerCase()
  if (SPAWN_POLICY_OPTIONS[raw]) return { name: raw, ...SPAWN_POLICY_OPTIONS[raw] }
  return null
}

export function normalizePermission(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizePermission(fallback)
  }
  const raw = String(value).trim().toLowerCase()
  const cap = resolveSpawnPolicyOption(raw)?.permission || legacyRung(raw, null) || raw
  if (!PERMISSION_NAMES.has(cap)) {
    throw new Error(`unknown spawn permission "${value}"`)
  }
  return cap
}

// Normalize any input into a coherent spawn policy. The region is DERIVED from
// the coarse name (REGION_FOR_PERMISSION), so the result is always coherent — a
// custom fence.json option may override the region, but the built-in names never
// disagree with their region. `network:false` (the only modifier) is carried
// through when explicitly present; otherwise net is on.
export function normalizeSpawnPolicy(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizeSpawnPolicy(fallback)
  }

  if (typeof value === 'string') {
    const option = resolveSpawnPolicyOption(value)
    if (option) return { name: option.name, permission: option.permission, policy: option.policy, category: 'write-scope' }
    const permission = normalizePermission(value)
    return { name: permission, permission, policy: REGION_FOR_PERMISSION[permission], category: 'write-scope' }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unknown spawn policy "${value}"`)
  }

  const option = value.name ? resolveSpawnPolicyOption(value.name) : null
  const permission = normalizePermission(value.permission || option?.permission)
  const policy = String(option?.policy || REGION_FOR_PERMISSION[permission] || '').trim().toLowerCase()
  return {
    name: option?.name || permission,
    permission,
    policy,
    category: 'write-scope',
    ...(value.network === false ? { network: false } : {}),
  }
}

// Harness inference. The harness (claude / codex / goose) is plumbing — HOW a
// model is run — and is used only for the optional `familyCeilings` config knob
// and harness-only fallbacks. It is NOT what governs the trust ceiling; the
// MODEL does (see modelTrustTier). goose is a harness, not a trust level.
export function modelFamily({ model, kind } = {}) {
  return sharedModelFamily({ model, kind })
}

// Model trust tiers — keyed on the MODEL identity, NOT the harness (Skip 06-19:
// "ceiling keyed on the model, not the harness"). The harness decides how a
// model runs; the model decides how much authority an operator could ever grant
// it. goose running minimax and goose running deepseek share a harness but sit
// at different tiers, which the old harness-family lumping got wrong.
//
//   full     — closed frontier models we trust fully (claude, gpt/openai):
//              up to full / unsandboxed.
//   elevated — trusted-but-bounded open models (minimax): tlda-write (write
//              across all tlda projects); raisable to full per-agent by the
//              operator.
//   narrow   — untrusted open models (deepseek, qwen, kimi, glm) and any
//              unrecognized model: write only their own cwd project, never
//              across projects and never machine-level. Safe by construction —
//              a tlda project is versioned on build, so any bad write recovers.
//
// This is a trust-TIER → coarse-policy dictionary (three named tiers → their
// region label), NOT a rank ladder: it is looked up by tier name, never
// ordered or compared. The model ceiling it produces is one of the region sets
// intersected in resolveSpawnGrant — a real fence input, not a parallel clamp.
const MODEL_TIER_POLICY = {
  full: { permission: 'full', policy: 'unsandboxed' },
  elevated: { permission: 'tlda-write', policy: 'tlda-projects' },
  narrow: { permission: 'write', policy: 'cwd' },
}

export function modelTrustTier({ model, kind } = {}) {
  return sharedModelTrustTier({ model, kind })
}

function defaultModelCeiling({ model, kind } = {}) {
  // Invariant (Skip): an agent's kind is ALWAYS known — a fresh spawn is passed it,
  // a woken agent has it in the ledger. So "neither model nor kind" is never a real
  // agent; it's a caller that failed to thread identity through. The OLD behavior
  // silently resolved that absence to the narrow tier and CAGED the agent to its cwd,
  // overriding its project profile — the exact bug that folder-clamped the whole
  // fleet. The model ceiling is a CAP on trust, not a lane; with no identity to cap,
  // it must contribute NO clamp (∩ ** is identity), leaving the project profile and
  // the spawner authority to bound the grant. We surface the missing identity loudly
  // (a record-keeping bug to fix at the caller) but never wedge on it.
  if (!model && !kind) {
    process.stderr.write('[spawn-policy] model ceiling requested with neither model nor kind; identity is always known — fix the caller. Applying no model cap.\n')
    return MODEL_TIER_POLICY.full // no cap: bounded by project profile ∩ spawner only
  }
  return MODEL_TIER_POLICY[modelTrustTier({ model, kind })]
}

export function modelCeiling(config = {}, { model, kind, trustOverride } = {}) {
  return modelSpawnCeiling(config, { model, kind, trustOverride }).permission
}

export function modelSpawnCeiling(config = {}, { model, kind, trustOverride } = {}) {
  // Per-agent operator override (e.g. a trusted minimax raised above its model
  // default). Operator-gated at the spawn boundary — this function trusts that
  // the caller already proved root before a trustOverride reached it.
  if (trustOverride != null && trustOverride !== '') {
    return normalizeSpawnPolicy(trustOverride, defaultModelCeiling({ model, kind }))
  }
  const family = modelFamily({ model, kind })
  const policy = config.spawnPolicy || {}
  const byModel = policy.modelCeilings || {}
  const byFamily = policy.familyCeilings || {}
  const configured = (model && byModel[model]) || byFamily[family] || policy.defaultCeiling
  return normalizeSpawnPolicy(configured, defaultModelCeiling({ model, kind }))
}

// Project-default profiles (Skip 06-19: "reasonable configurations on a
// project-by-project level… generally set once"). A project carries a profile;
// spawning into it inherits that profile as the DEFAULT FENCE. The profile is
// the *default*, the model ceiling is the *cap* — effective authority is the
// lower of (profile, model ceiling, caller). This default fence applies to
// EVERYONE including Claude: a Claude in a math project gets the math profile
// (fenced to math projects) so it stays in its lane, even though its model could
// be trusted with more. The profile sets the LANE (where you may write); the
// model tier sets the TRUST (how high the operator could raise you).
//
//   ops       — machine-level (the operator's host-work project): full.
//   app       — dev + tester: code, git, dev-server, browser, network, all
//               inside the worktree (cwd); the fence lease widens cwd to include
//               the dev caches so the job is never blocked.
//   math      — write across all tlda/math projects (tlda-write).
//   untrusted — write only its own project (cwd); never across projects, never
//               machine-level. Same lane as app; the trust difference is carried
//               by the model ceiling, not the lane.
// Built-in profile-name → coarse-policy fallback. The real authority for a
// profile is the operator's daemon.yaml region set (configuredPermissionProfile),
// whose coarse label is DERIVED from its regions (derivedPolicyFromRegionSet).
// This dictionary only names the built-in profiles the config does not define —
// so a bare `ops`/`math`/`cwd` still resolves when no daemon.yaml entry covers
// it. It is a flat name→policy lookup, NOT a rank ladder: nothing here orders,
// ranks, or meets these names.
const BUILTIN_PROFILE_POLICY = {
  none: { permission: 'none', policy: 'cwd' },
  'read-only': { permission: 'read', policy: 'cwd' },
  ops: { permission: 'full', policy: 'unsandboxed' },
  'app-dev': { permission: 'full', policy: 'unsandboxed' },
  deploy: { permission: 'write', policy: 'cwd' },
  app: { permission: 'write', policy: 'cwd' },
  cwd: { permission: 'write', policy: 'cwd' },
  math: { permission: 'tlda-write', policy: 'tlda-projects' },
  'math-project': { permission: 'tlda-write', policy: 'tlda-projects' },
  'math-projects': { permission: 'tlda-write', policy: 'tlda-projects' },
  untrusted: { permission: 'write', policy: 'cwd' },
}

export const DEFAULT_SPAWN_PROFILE = 'cwd'
export const PERMISSION_OPERATIONS = ['read', 'write', 'spawn']

function emptyPermissionOperations() {
  const operations = {}
  for (const operation of PERMISSION_OPERATIONS) {
    operations[operation] = { allow: [], deny: [] }
  }
  return operations
}

function normalizePermissionOperation(value, lineNumber) {
  const operation = String(value || '').trim().toLowerCase()
  if (!PERMISSION_OPERATIONS.includes(operation)) {
    const suffix = lineNumber ? ` on line ${lineNumber}` : ''
    throw new Error(`unknown permission operation "${value}"${suffix}`)
  }
  return operation
}

function normalizePermissionProfileName(value, lineNumber) {
  const name = String(value || '').trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    const suffix = lineNumber ? ` on line ${lineNumber}` : ''
    throw new Error(`invalid permission profile name "${value}"${suffix}`)
  }
  return name
}

function addPermissionRule(profile, { operation, effect, zone, line }) {
  const rule = { operation, effect, zone, line }
  profile.rules.push(rule)
  profile.operations[operation][effect].push(zone)
}

export function compilePermissionProfiles(source, { sourcePath } = {}) {
  if (typeof source !== 'string') throw new Error('permission profile source must be a string')
  const profiles = {}
  let current = null
  const lines = source.split(/\r?\n/)
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNumber = idx + 1
    const raw = lines[idx]
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const header = line.match(/^profile\s+([A-Za-z0-9_.-]+)\s*:\s*$/)
    if (header) {
      const name = normalizePermissionProfileName(header[1], lineNumber)
      const key = name.toLowerCase()
      if (profiles[key]) throw new Error(`duplicate permission profile "${name}" on line ${lineNumber}`)
      current = {
        type: 'permission-set',
        name,
        operations: emptyPermissionOperations(),
        rules: [],
        ...(sourcePath ? { sourcePath } : {}),
      }
      profiles[key] = current
      continue
    }

    if (!current) throw new Error(`permission rule before profile header on line ${lineNumber}`)
    const rule = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+([+-])\s+(.+?)\s*$/)
    if (!rule) throw new Error(`invalid permission rule on line ${lineNumber}: ${raw.trim()}`)
    const operation = normalizePermissionOperation(rule[1], lineNumber)
    const effect = rule[2] === '+' ? 'allow' : 'deny'
    const zone = rule[3].trim()
    if (!zone) throw new Error(`empty permission zone on line ${lineNumber}`)
    addPermissionRule(current, { operation, effect, zone, line: lineNumber })
  }
  if (!Object.keys(profiles).length) throw new Error('permission profile source contains no profile blocks')
  return {
    type: 'permission-profile-bundle',
    profiles,
    ...(sourcePath ? { sourcePath } : {}),
  }
}

function selectCompiledPermissionProfile(bundle, requestedName = null) {
  const keys = Object.keys(bundle.profiles || {})
  if (!keys.length) throw new Error('compiled permission bundle contains no profiles')
  if (requestedName) {
    const key = String(requestedName).trim().toLowerCase()
    const profile = bundle.profiles[key]
    if (!profile) throw new Error(`permission profile "${requestedName}" not found`)
    return profile
  }
  if (keys.length === 1) return bundle.profiles[keys[0]]
  throw new Error('permission profile source has multiple profiles; specify profile/name')
}

const BUILTIN_PERMISSION_PROFILE_SOURCE = `
profile app-dev:
  read + cwd
  write + cwd
  spawn + **
  read + ~/.config/tlda/fleet-daemon.log
  write + ~/.config/tlda/fleet-daemon.log
  read + ~/.config/tlda/fleet-daemon.pid
  write + ~/.config/tlda/fleet-daemon.pid
  read + ~/.config/tlda/fleet-daemon.*.lock
  write + ~/.config/tlda/fleet-daemon.*.lock

profile deploy:
  read + cwd
  write + cwd
  spawn + **
  read + ~/.fly/**
  write + ~/.fly/**
  read + ~/.cache/fly/**
  write + ~/.cache/fly/**
  read + ~/Library/Caches/fly/**
  write + ~/Library/Caches/fly/**
`

let builtinPermissionBundle = null

function builtinPermissionProfiles() {
  if (!builtinPermissionBundle) builtinPermissionBundle = compilePermissionProfiles(BUILTIN_PERMISSION_PROFILE_SOURCE, { sourcePath: 'builtin' })
  return builtinPermissionBundle
}

// The built-in permission-profile names (app-dev, deploy) — the region-set
// profiles that ship in code, distinct from the operator's daemon.yaml profiles.
// Exposed so CLI help/error text can list every recognized profile name.
export function builtinPermissionProfileNames() {
  return Object.keys(builtinPermissionProfiles().profiles)
}

function zoneForPolicy(policy, { cwd, project } = {}) {
  if (policy.policy === 'unsandboxed') return '**'
  const base = policy.policy === 'tlda-projects'
    ? (project?.sourceDir || cwd || 'tlda-projects')
    : (cwd || policy.policy)
  if (base === 'cwd' || base === 'tlda-projects') return base
  const resolved = normalizedPath(base)
  return `${resolved || base}/**`
}

export function permissionSetFromPolicy(policyValue, { name, cwd, project } = {}) {
  const policy = normalizeSpawnPolicy(policyValue)
  const zone = zoneForPolicy(policy, { cwd, project })
  const operations = emptyPermissionOperations()
  const rules = []
  if (policy.permission !== 'none') {
    const readRule = { operation: 'read', effect: 'allow', zone, line: null }
    rules.push(readRule)
    operations.read.allow.push(zone)
  }
  if (policy.permission !== 'none' && policy.permission !== 'read') {
    const writeRule = { operation: 'write', effect: 'allow', zone, line: null }
    rules.push(writeRule)
    operations.write.allow.push(zone)
  }
  if (policy.permission !== 'none') {
    const spawnRule = { operation: 'spawn', effect: 'allow', zone: '**', line: null }
    rules.push(spawnRule)
    operations.spawn.allow.push('**')
  }
  return {
    type: 'permission-set',
    name: name || policy.name,
    operations,
    rules,
    projectedPolicy: policy,
    compiledFrom: 'spawn-policy',
  }
}

export function emptyPermissionSet({ name = 'none', projectedPolicy = 'none' } = {}) {
  return {
    type: 'permission-set',
    name,
    operations: emptyPermissionOperations(),
    rules: [],
    projectedPolicy: normalizeSpawnPolicy(projectedPolicy, 'none'),
    compiledFrom: 'empty-permission-set',
  }
}

function globRoot(zone) {
  const raw = String(zone || '').trim()
  if (!raw || raw === '**' || raw === '/**') return { universal: true, root: raw, glob: true }
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  const glob = /[*?[\]]/.test(expanded)
  const root = expanded.endsWith('/**') ? expanded.slice(0, -3) : expanded
  return { universal: false, root: root || '/', glob }
}

function zoneContains(container, candidate) {
  const a = globRoot(container)
  const b = globRoot(candidate)
  if (a.universal) return true
  if (b.universal) return false
  if (a.root === b.root) return true
  if (String(container).endsWith('/**')) return b.root.startsWith(`${a.root}/`)
  return false
}

function intersectTwoZones(left, right) {
  if (zoneContains(left, right)) return right
  if (zoneContains(right, left)) return left
  return null
}

function uniqueRules(rules) {
  const seen = new Set()
  const out = []
  for (const rule of rules) {
    const key = `${rule.operation}\0${rule.effect}\0${rule.zone}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(rule)
  }
  return out
}

function clonePermissionSet(set) {
  const operations = emptyPermissionOperations()
  const rules = []
  for (const operation of PERMISSION_OPERATIONS) {
    for (const effect of ['allow', 'deny']) {
      for (const zone of set.operations?.[operation]?.[effect] || []) {
        operations[operation][effect].push(zone)
      }
    }
  }
  for (const rule of set.rules || []) rules.push({ ...rule })
  return { ...set, operations, rules }
}

function builtinPermissionProfile(name) {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  const profile = builtinPermissionProfiles().profiles[key]
  if (!profile) return null
  const cloned = clonePermissionSet(profile)
  cloned.projectedPolicy = normalizeSpawnPolicy(BUILTIN_PROFILE_POLICY[key] || 'write')
  cloned.compiledFrom = 'builtin-permission-profile'
  return cloned
}

function intersectPermissionPair(left, right) {
  const operations = emptyPermissionOperations()
  let rules = []
  for (const operation of PERMISSION_OPERATIONS) {
    const allow = []
    for (const a of left.operations?.[operation]?.allow || []) {
      for (const b of right.operations?.[operation]?.allow || []) {
        const zone = intersectTwoZones(a, b)
        if (zone) allow.push(zone)
      }
    }
    operations[operation].allow = [...new Set(allow)]
    operations[operation].deny = [...new Set([
      ...(left.operations?.[operation]?.deny || []),
      ...(right.operations?.[operation]?.deny || []),
    ])]
    for (const zone of operations[operation].allow) {
      rules.push({ operation, effect: 'allow', zone, line: null })
    }
    for (const zone of operations[operation].deny) {
      rules.push({ operation, effect: 'deny', zone, line: null })
    }
  }
  rules = uniqueRules(rules)
  return {
    type: 'permission-set',
    name: `${left.name || 'left'}&${right.name || 'right'}`,
    operations,
    rules,
    compiledFrom: 'intersection',
  }
}

export function intersectPermissionSets(sets, { name = 'grant', projectedPolicy = null } = {}) {
  const normalized = sets.filter(Boolean).map(clonePermissionSet)
  if (!normalized.length) throw new Error('cannot intersect an empty permission-set list')
  let current = normalized[0]
  for (const next of normalized.slice(1)) current = intersectPermissionPair(current, next)
  current.name = name
  if (projectedPolicy) current.projectedPolicy = projectedPolicy
  return current
}

export function permissionSetLte(left, right) {
  for (const operation of PERMISSION_OPERATIONS) {
    for (const zone of left.operations?.[operation]?.allow || []) {
      if (!(right.operations?.[operation]?.allow || []).some((candidate) => zoneContains(candidate, zone))) return false
    }
    for (const zone of right.operations?.[operation]?.deny || []) {
      if (!(left.operations?.[operation]?.deny || []).includes(zone)) return false
    }
  }
  return true
}

function looksLikePermissionSet(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.type === 'permission-set'
    && value.operations
    && typeof value.operations === 'object'
}

// A write zone that covers the whole machine — the signal that a region set is
// "unsandboxed / full". Matches the universal globs the fence treats as machine
// scope (permissions.mjs / permission-ledger.mjs derivedPolicyFromOperations).
function isMachineZone(zone) {
  const raw = String(zone || '').trim()
  return raw === '**' || raw === '/' || raw === '/**'
}

// Derive the coarse permission NAME from a region set's operation zones — no
// rank ladder, just region inspection. A machine-covering write ⇒ full; an
// explicit tlda-projects write ⇒ tlda-write; any other write ⇒ write; read-only
// ⇒ read; nothing ⇒ none. This is the canonical way to name an INTERSECTED
// region set (the real fence input) for display and sandbox-region selection.
function derivedPolicyFromRegionSet(permissions, name, fallback = DEFAULT_AGENT_PERMISSION) {
  const writeAllow = permissions.operations?.write?.allow || []
  const readAllow = permissions.operations?.read?.allow || []
  const permission = writeAllow.some(isMachineZone)
    ? 'full'
    : writeAllow.some((zone) => String(zone).trim() === 'tlda-projects')
      ? 'tlda-write'
      : writeAllow.length
        ? 'write'
        : readAllow.length
          ? 'read'
          : 'none'
  return { ...normalizeSpawnPolicy(permission, fallback), ...(name ? { name } : {}) }
}

// Name a permission set as a coarse policy. A daemon.yaml (or builtin) profile
// already carries a `projectedPolicy` computed from its regions at
// normalization; honor it. Otherwise derive the name from the set's own region
// zones — no rung ladder, no parallel profile map.
function policyForPermissionSet(permissions, fallback = DEFAULT_AGENT_PERMISSION) {
  if (permissions.projectedPolicy) return normalizeSpawnPolicy(permissions.projectedPolicy, fallback)
  return derivedPolicyFromRegionSet(permissions, null, fallback)
}

function normalizedPath(value) {
  if (!value || typeof value !== 'string') return null
  try {
    return resolve(value)
  } catch {
    return null
  }
}

function pathInside(child, parent) {
  const c = normalizedPath(child)
  const p = normalizedPath(parent)
  return !!(c && p && (c === p || c.startsWith(`${p}/`)))
}

function pathBasename(value) {
  const p = normalizedPath(value)
  return p ? basename(p).toLowerCase() : null
}

function firstKnownProfile(...values) {
  for (const value of values) {
    const name = String(value || '').trim().toLowerCase()
    if (BUILTIN_PROFILE_POLICY[name]) return name
  }
  return null
}

function configuredPermissionProfiles(config = {}) {
  const profiles = config.spawnPolicy?.permissionProfiles || {}
  return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {}
}

function configuredPermissionProfile(config = {}, name) {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  const profile = configuredPermissionProfiles(config)[key]
  if (!looksLikePermissionSet(profile)) return null
  const cloned = clonePermissionSet(profile)
  cloned.compiledFrom = cloned.compiledFrom || 'daemon-config-profile'
  return cloned
}

// The operator config addresses levels by permission word (`full`) as often as
// by profile NAME (`ops`, `app`). Historically only names were recognized, so a
// configured `full` was silently dropped and the spawn fell into the `cwd`
// trap. Map the permission word to the profile that carries the intended
// permission set: `full` → `ops` (whole machine, secrets fenced off — "fence but
// don't trap"). Names still take precedence; this only rescues permission words.
const PERMISSION_PROFILE_ALIAS = { full: 'ops' }

function firstConfiguredOrKnownProfile(config = {}, ...values) {
  const configured = configuredPermissionProfiles(config)
  for (const value of values) {
    let name = String(value || '').trim().toLowerCase()
    name = PERMISSION_PROFILE_ALIAS[name] || name
    if (configured[name] || BUILTIN_PROFILE_POLICY[name]) return name
  }
  return null
}

function configuredProjectProfileName(config = {}, projectProfiles = {}, keys = []) {
  for (const key of keys) {
    if (!key) continue
    const configured = projectProfiles[key] ?? projectProfiles[String(key).toLowerCase()]
    const name = firstConfiguredOrKnownProfile(config, configured)
    if (name) return name
  }
  return null
}

// Resolve which profile NAME a spawn should inherit. Precedence:
// the project record's own `profile` field → config.spawnPolicy.projectProfiles
// keyed by project name / sourceDir / cwd basename → built-in basename profile
// → DEFAULT_SPAWN_PROFILE. The daemon permission ledger is the authority for
// caller grants; config.json must not invent a broad default profile.
export function resolveProjectProfileName(config = {}, { doc, project, cwd } = {}) {
  const policy = config.spawnPolicy || {}
  const projectProfiles = policy.projectProfiles || {}
  const sourceDir = project?.sourceDir || null
  const cwdMatchesProject = cwd && sourceDir && pathInside(cwd, sourceDir)
  return firstConfiguredOrKnownProfile(config, project?.profile)
    || configuredProjectProfileName(config, projectProfiles, [
      doc,
      project?.name,
      sourceDir,
      pathBasename(sourceDir),
      cwd,
      pathBasename(cwd),
    ])
    || firstConfiguredOrKnownProfile(config,
      cwdMatchesProject ? pathBasename(sourceDir) : null,
      pathBasename(cwd)
    )
    || firstConfiguredOrKnownProfile(config, policy.defaultProfile)
    || DEFAULT_SPAWN_PROFILE
}

// The profile a spawn inherits, as a normalized spawn policy. This becomes the
// requested permission when the caller does not request one explicitly — the
// default fence. resolveSpawnGrant still bounds it, via the region-set
// intersection, by the model ceiling and the spawner's own authority.
export function resolveProjectProfile(config = {}, { doc, project, cwd } = {}) {
  const name = resolveProjectProfileName(config, { doc, project, cwd })
  const configured = configuredPermissionProfile(config, name)
  if (configured) {
    const policy = policyForPermissionSet(configured, BUILTIN_PROFILE_POLICY[name] || DEFAULT_AGENT_PERMISSION)
    return { ...policy, name }
  }
  return { ...normalizeSpawnPolicy(BUILTIN_PROFILE_POLICY[name]), name }
}

function permissionSetForProfileName(name, policy, { cwd, project, config } = {}) {
  const configured = configuredPermissionProfile(config, name)
  if (configured) return configured
  const builtinProfile = builtinPermissionProfile(name)
  if (builtinProfile) return builtinProfile
  return permissionSetFromPolicy(policy, { name: policy.name, cwd, project })
}

function materializePermissionZone(zone, { cwd, project } = {}) {
  const raw = String(zone || '').trim()
  if (!raw) return null
  if (raw === 'cwd') {
    const root = normalizedPath(cwd || project?.sourceDir)
    return root ? `${root}/**` : raw
  }
  if (raw === 'tlda-projects') {
    const root = normalizedPath(project?.sourceDir || cwd)
    return root ? `${root}/**` : raw
  }
  if (raw === '**') return raw
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

function materializePermissionSet(permissionSet, { cwd, project } = {}) {
  if (!permissionSet || typeof permissionSet !== 'object') return permissionSet
  const operations = emptyPermissionOperations()
  const rules = []
  for (const operation of PERMISSION_OPERATIONS) {
    for (const effect of ['allow', 'deny']) {
      for (const zone of permissionSet.operations?.[operation]?.[effect] || []) {
        const materialized = materializePermissionZone(zone, { cwd, project })
        if (!materialized) continue
        operations[operation][effect].push(materialized)
        rules.push({ operation, effect, zone: materialized, line: null })
      }
    }
  }
  return {
    ...permissionSet,
    operations,
    rules,
    materializedFrom: permissionSet.name || permissionSet.materializedFrom || 'permission-set',
  }
}

function normalizeProfileOrPolicyName(value) {
  const name = String(value || '').trim().toLowerCase()
  if (BUILTIN_PROFILE_POLICY[name]) return { ...normalizeSpawnPolicy(BUILTIN_PROFILE_POLICY[name]), name }
  return normalizeSpawnPolicy(value)
}

function withPermissionSet(policy, permissionSet) {
  return {
    ...policy,
    permissionSet,
  }
}

export function normalizeRequestedPermissions(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizeRequestedPermissions(fallback)
  }
  if (typeof value === 'string') {
    const builtinProfile = builtinPermissionProfile(value)
    if (builtinProfile) {
      const policy = policyForPermissionSet(builtinProfile, fallback || DEFAULT_AGENT_PERMISSION)
      return withPermissionSet({ ...policy, name: builtinProfile.name }, builtinProfile)
    }
    const policy = normalizeProfileOrPolicyName(value)
    return withPermissionSet(policy, permissionSetFromPolicy(policy, { name: policy.name }))
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unknown permission request "${value}"`)
  }
  if (looksLikePermissionSet(value)) {
    const policy = policyForPermissionSet(value, fallback || DEFAULT_AGENT_PERMISSION)
    return withPermissionSet(policy, value)
  }
  if (value.permission) {
    const policy = normalizeSpawnPolicy(value)
    return withPermissionSet(policy, permissionSetFromPolicy(policy, { name: policy.name }))
  }
  if (value.type === 'permission-profile-bundle') {
    const profile = selectCompiledPermissionProfile(value, value.profile || value.preset || value.name)
    const policy = policyForPermissionSet(profile, fallback || DEFAULT_AGENT_PERMISSION)
    return withPermissionSet(policy, profile)
  }
  if (typeof value.source === 'string') {
    const bundle = compilePermissionProfiles(value.source, { sourcePath: value.sourcePath })
    const profile = selectCompiledPermissionProfile(bundle, value.profile || value.preset || value.name)
    const policy = policyForPermissionSet(profile, fallback || DEFAULT_AGENT_PERMISSION)
    return withPermissionSet(policy, profile)
  }
  const named = value.profile || value.preset || value.name
  if (named) {
    const builtinProfile = builtinPermissionProfile(named)
    if (builtinProfile) {
      const policy = policyForPermissionSet(builtinProfile, fallback || DEFAULT_AGENT_PERMISSION)
      return withPermissionSet({ ...policy, name: builtinProfile.name }, builtinProfile)
    }
    const policy = normalizeProfileOrPolicyName(named)
    return withPermissionSet(policy, permissionSetFromPolicy(policy, { name: policy.name }))
  }
  throw new Error('unknown permission request; expected a named profile, compiled permission set, or profile source')
}

// The operator (human, or the server owner identity) is root: never fenced, can
// confer any permission up to and including destructive full, and is the ONLY
// caller permitted to raise a model's trust ceiling per-agent. Every agent, no
// matter how trusted its model, resolves here as non-operator — so an agent can
// never self-escalate.
export function isOperator(caller, { serverOwnerId } = {}) {
  return !!(caller?.human || (serverOwnerId && caller?.id === serverOwnerId))
}

// Interpret a stored spawnPolicy blob into one of the named rungs. The conferral
// level is the stored PERMISSION, not the stored region: the register handler
// used to shallow-merge spawnPolicy across writers and the global fence-off
// stamped `unsandboxed` onto many rows, corrupting the REGION — but the
// permission field still reflects what the agent was spawned with. So we honor
// the permission and DERIVE the region (REGION_FOR_PERMISSION), which both (a)
// repairs the corrupted region by tightening it back to the name's real scope,
// and (b) never confers above the stored rung — no auto-promotion on a guess.
//
// The one place the stored region carries meaning is the legacy write /
// tlda-write split: both were `workspace-write`, distinguished only by region
// (`cwd` vs `tlda-projects`). So for a legacy workspace-write blob the region
// `tlda-projects` (and only that) means tlda-write; any other region (cwd, the
// corrupted unsandboxed, or absent) means plain write. Returns a rung, or null
// for an unrecognized permission string.
//
// Worked outcomes on the live Fly population: mathchat2 `{read-only, unsandboxed}`
// → `read` (honor read; the corrupted region is ignored) — Skip's call: a
// corrupted math agent stays read under the code default and is promoted to
// write only by the operator-gated sweep. The ~60 `{workspace-write*, unsandboxed}`
// fence-off rows → `write` (honor write; region repaired to cwd) — NOT demoted
// to read. A legacy `{workspace-write, tlda-projects}` → `tlda-write` (scope
// preserved).
function storedConferralRung(stored) {
  const blob = typeof stored === 'string' ? { permission: stored } : stored
  if (!blob || typeof blob !== 'object' || blob.permission == null) return null
  return legacyRung(blob.permission, blob.policy)
}

// Conferral resolution. By what the agent's stored spawnPolicy is:
//   • absent             → DEFAULT_AGENT_PERMISSION (write). The historical
//                          default for the ~495 never-assigned agents; unchanged.
//   • recognized rung    → honored (read reviewers stay read; write agents stay
//                          write; tlda scope preserved; corrupted region repaired).
//   • unrecognized blob  → `read`. Never trusted to confer up; the correct
//                          permission is restored only by the operator-gated,
//                          role-aware re-projection sweep (Skip's call).
export function callerSpawnPolicy(caller, { serverOwnerId } = {}) {
  if (isOperator(caller, { serverOwnerId })) return normalizeSpawnPolicy(ROOT_PERMISSION)
  const stored = caller?.metadata?.spawnPolicy
  if (stored == null) return normalizeSpawnPolicy(DEFAULT_AGENT_PERMISSION)
  return normalizeSpawnPolicy(storedConferralRung(stored) || 'read')
}

export function callerPermission(caller, { serverOwnerId } = {}) {
  return callerSpawnPolicy(caller, { serverOwnerId }).permission
}

// Coerce a (possibly corrupted or legacy) stored spawnPolicy blob into a
// coherent four-name rung policy for ATOMIC persistence. The register handler
// used to shallow-merge spawnPolicy fields across writers, minting incoherent
// blobs like {read-only, unsandboxed}; persisting the coherent rung instead
// means no new corruption can form. This repairs the REPRESENTATION only — the
// conferral level (the rung) is unchanged, so it never promotes or demotes an
// agent (mathchat2's {read-only, unsandboxed} stores as {read, cwd}, still read;
// a real change of permission is the operator-gated sweep, not this). Returns
// the coherent policy, or null when there is nothing storable.
export function coherentSpawnPolicy(stored) {
  if (stored == null) return null
  const rung = storedConferralRung(stored)
  if (!rung) return null
  const netOff = typeof stored === 'object' && !Array.isArray(stored) && stored.network === false
  return { ...normalizeSpawnPolicy(rung), ...(netOff ? { network: false } : {}) }
}

export function resolveSpawnGrant({
  requestedPermission,
  requestedPermissions,
  callerRung,
  requester,
  spawnerPolicy: explicitSpawnerPolicy,
  spawnerPermissionSet: explicitSpawnerPermissionSet,
  model,
  kind,
  config = {},
  doc,
  project,
  cwd,
} = {}) {
  const projectPolicy = resolveProjectProfile(config, { doc, project, cwd })
  const modelPolicy = modelSpawnCeiling(config, { model, kind })
  const spawnerPolicy = explicitSpawnerPolicy
    ? normalizeSpawnPolicy(explicitSpawnerPolicy)
    : requester?.id
    ? callerSpawnPolicy({
        id: requester.id,
        human: !!requester.human,
        metadata: { spawnPolicy: requester.spawnPolicy || requester.metadata?.spawnPolicy },
      })
    : normalizeSpawnPolicy(callerRung, ROOT_PERMISSION)
  const projectPermissionSet = permissionSetForProfileName(projectPolicy.name, projectPolicy, { cwd, project, config })
  // A requested --permissions <profile> is resolved against the operator's
  // daemon.yaml profiles (named read/write region-sets) FIRST; only a request that
  // is not one of those falls back to the legacy named policies. This is what makes
  // readonly/wd/math/app/ops resolve to their real regions instead of throwing.
  const requestedName = typeof (requestedPermissions ?? requestedPermission) === 'string'
    ? String(requestedPermissions ?? requestedPermission).trim().toLowerCase()
    : null
  const configuredRequested = requestedName ? configuredPermissionProfile(config, requestedName) : null
  const requestedPolicy = configuredRequested
    ? withPermissionSet({ ...policyForPermissionSet(configuredRequested, DEFAULT_AGENT_PERMISSION), name: requestedName }, configuredRequested)
    : requestedPermissions || requestedPermission
    ? normalizeRequestedPermissions(requestedPermissions || requestedPermission, DEFAULT_AGENT_PERMISSION)
    : withPermissionSet(projectPolicy, projectPermissionSet)
  const modelPermissionSet = permissionSetFromPolicy(modelPolicy, { name: modelPolicy.name, cwd, project })
  const spawnerPermissionSet = explicitSpawnerPermissionSet
    ? materializePermissionSet(explicitSpawnerPermissionSet, { cwd, project })
    : permissionSetFromPolicy(spawnerPolicy, { name: spawnerPolicy.name, cwd, project })
  const requestedPermissionSet = requestedPolicy.permissionSet
    || (requestedPermissions || requestedPermission
      ? permissionSetFromPolicy(requestedPolicy, { name: requestedPolicy.name, cwd, project })
      : projectPermissionSet)
  // The grant is the region-set intersection of what was requested, what the
  // model may ever hold, and what the spawner can confer — the ONE fence input.
  // The coarse grantedPolicy (a "how open" label) is DERIVED from that
  // intersected region set (policyForPermissionSet): a machine-covering write ⇒
  // full/unsandboxed (ops stays bypass), an empty write region ⇒ read-only. No
  // parallel rank clamp computes it.
  const grantedPermissionSet = intersectPermissionSets([
    materializePermissionSet(requestedPermissionSet, { cwd, project }),
    modelPermissionSet,
    spawnerPermissionSet,
  ], { name: 'grant' })
  const grantedPolicy = policyForPermissionSet(grantedPermissionSet, DEFAULT_AGENT_PERMISSION)
  grantedPermissionSet.name = grantedPolicy.name
  grantedPermissionSet.projectedPolicy = grantedPolicy
  return {
    requestedPermission: requestedPolicy.permission,
    requestedPolicy,
    requestedPermissions: requestedPermissionSet,
    requestedPermissionSet,
    callerPermission: spawnerPolicy.permission,
    callerPolicy: spawnerPolicy,
    spawnerPermission: spawnerPolicy.permission,
    spawnerPolicy,
    projectPermission: projectPolicy.permission,
    projectPolicy,
    modelPermission: modelPolicy.permission,
    modelPolicy,
    machineAllowedPermission: grantedPolicy.permission,
    machineAllowedPolicy: grantedPolicy,
    grantedPermission: grantedPolicy.permission,
    grantedPolicy,
    grantedPermissions: grantedPermissionSet,
    grantedPermissionSet,
  }
}

export function resolveDirectSpawnGrant(options = {}) {
  return resolveSpawnGrant({
    ...options,
    spawnerPolicy: ROOT_PERMISSION,
  })
}
