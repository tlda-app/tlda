import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { modelFamily as sharedModelFamily, modelTrustTier as sharedModelTrustTier } from '../../shared/harness.ts'

// Skip's ONE capability vocabulary — named rungs, low → high. This is the
// only capability vocabulary tlda owns; there is NO machine vocabulary
// (workspace-*, *-no-net, full-access) on any tlda surface. The filesystem
// REGION each rung fences to is PART OF THE NAME (tlda-write = write across all
// tlda projects), not a second axis. "no-net" is not a rung — net is always on
// (Skip: "literally every type of agent should be able to use the Internet");
// it survives only as a never-typed `network:false` modifier. The single foreign
// string that survives is Codex's own sandbox API value, mapped at the
// fleet-spawn boundary, not here.
export const CAPABILITIES = ['none', 'read', 'write', 'tlda-write', 'full']
const CAPABILITY_RANK = new Map(CAPABILITIES.map((cap, idx) => [cap, idx]))

// The fence directory-region each rung fences to. These region names
// (cwd / tlda-projects / unsandboxed) are the FENCE's own vocabulary for
// directory scopes — not a second capability vocabulary — and are DERIVED from
// the rung, never typed by anyone. Because the region follows the rung, the four
// names form a single total chain: there is no separate filesystem-policy axis.
export const CAPABILITY_REGION = {
  none: 'cwd',
  read: 'cwd',
  write: 'cwd',
  'tlda-write': 'tlda-projects',
  full: 'unsandboxed',
}

export const DEFAULT_AGENT_CAPABILITY = 'write'
export const ROOT_CAPABILITY = 'full'

// Interpret an old-vocabulary (capability, region) pair into a four-name rung —
// the ONE place legacy machine words are read. This is for PERSISTED data and
// the operator's fence.json (which may still hold old words); it is NOT a
// user-facing alias. The region disambiguates the legacy write / tlda-write
// split (both were `workspace-write`). `workspace-write-no-net` → write: net is
// now always on, so old no-net rows correctly gain net. Returns a rung or null.
// Removable once every live agent and fence.json use the current names.
function legacyRung(capability, region) {
  const raw = String(capability ?? '').trim().toLowerCase()
  if (CAPABILITY_RANK.has(raw)) return raw // already a four-name rung
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
  read: { capability: 'read', policy: 'cwd', category: 'write-scope' },
  write: { capability: 'write', policy: 'cwd', category: 'write-scope' },
  'tlda-write': { capability: 'tlda-write', policy: 'tlda-projects', category: 'write-scope' },
  full: { capability: 'full', policy: 'unsandboxed', category: 'write-scope' },
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
  // Valid fence region names — the values CAPABILITY_REGION can produce plus the
  // regions the fence's own sandbox resolver (permissions.mjs SANDBOX_POLICIES)
  // accepts as write-scope policies. 'no-dev' is a valid sandbox policy but not
  // a write-scope region, so it is excluded here.
  const VALID_REGIONS = new Set(['cwd', 'tlda-projects', 'unsandboxed'])
  for (const [name, def] of Object.entries(loadFenceConfigPolicies())) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue
    // The operator's fence.json may still describe a policy in OLD vocabulary
    // (capability `full-access`, writeScope `unsandboxed`). Normalize it to a
    // four-name rung so a stale config can't reintroduce machine vocabulary.
    const rung = legacyRung(def.capability, def.policy ?? def.writeScope)
      || (CAPABILITY_RANK.has(name) ? name : merged[name]?.capability)
    if (!rung || !CAPABILITY_RANK.has(rung)) continue
    // Use the operator's configured region when it is a recognized fence region,
    // falling back to the rung-derived default. This fixes the "config thrown
    // out" bug where every policy was force-derived from CAPABILITY_REGION[rung]
    // regardless of what the operator wrote in fence.json.
    const operatorRegion = (def.policy ?? def.writeScope ?? '')
    const region = VALID_REGIONS.has(operatorRegion) ? operatorRegion : CAPABILITY_REGION[rung]
    merged[name] = { capability: rung, policy: region, category: 'write-scope' }
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

export function normalizeCapability(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizeCapability(fallback)
  }
  const raw = String(value).trim().toLowerCase()
  const cap = resolveSpawnPolicyOption(raw)?.capability || legacyRung(raw, null) || raw
  if (!CAPABILITY_RANK.has(cap)) {
    throw new Error(`unknown spawn capability "${value}"`)
  }
  return cap
}

// Normalize any input into a coherent spawn policy. The region is DERIVED from
// the rung (CAPABILITY_REGION), so the result is always coherent — a custom
// fence.json option may override the region, but the four built-in rungs never
// disagree with their region. `network:false` (the only modifier) is carried
// through when explicitly present; otherwise net is on.
export function normalizeSpawnPolicy(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizeSpawnPolicy(fallback)
  }

  if (typeof value === 'string') {
    const option = resolveSpawnPolicyOption(value)
    if (option) return { name: option.name, capability: option.capability, policy: option.policy, category: 'write-scope' }
    const capability = normalizeCapability(value)
    return { name: capability, capability, policy: CAPABILITY_REGION[capability], category: 'write-scope' }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unknown spawn policy "${value}"`)
  }

  const option = value.name ? resolveSpawnPolicyOption(value.name) : null
  const capability = normalizeCapability(value.capability || option?.capability)
  const policy = String(option?.policy || CAPABILITY_REGION[capability] || '').trim().toLowerCase()
  return {
    name: option?.name || capability,
    capability,
    policy,
    category: 'write-scope',
    ...(value.network === false ? { network: false } : {}),
  }
}

export function capabilityLte(left, right) {
  const a = normalizeCapability(left)
  const b = normalizeCapability(right)
  return CAPABILITY_RANK.get(a) <= CAPABILITY_RANK.get(b)
}

// One axis: a policy is ≤ another iff its rung is ≤ the other's. The region
// follows the rung, so there is no separate filesystem-policy comparison.
export function spawnPolicyLte(left, right) {
  return capabilityLte(normalizeSpawnPolicy(left).capability, normalizeSpawnPolicy(right).capability)
}

// The greatest-lower-bound (meet) of a set of spawn policies: the min rung over
// the single capability ladder (the region follows it). The result is always ≤
// every input, so it can never confer more than any bound allows. This is how a
// spawn CLAMPS instead of refusing — Skip's rule: "Every agent should be able to
// spawn agents with no more privileges than they have." A spawn never fails on
// capability grounds; it hands down the lower of the bounds. If any bound is
// net-restricted, the child is too.
export function meetSpawnPolicies(policies) {
  const norm = policies.map((p) => normalizeSpawnPolicy(p))
  let capability = norm[0].capability
  let network = norm[0].network === false ? false : undefined
  for (const p of norm.slice(1)) {
    if (CAPABILITY_RANK.get(p.capability) < CAPABILITY_RANK.get(capability)) capability = p.capability
    if (p.network === false) network = false
  }
  return {
    name: capability,
    capability,
    policy: CAPABILITY_REGION[capability],
    category: 'write-scope',
    ...(network === false ? { network: false } : {}),
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
export const MODEL_TRUST_TIERS = {
  full: { capability: 'full', policy: 'unsandboxed' },
  elevated: { capability: 'tlda-write', policy: 'tlda-projects' },
  narrow: { capability: 'write', policy: 'cwd' },
}

export function modelTrustTier({ model, kind } = {}) {
  return sharedModelTrustTier({ model, kind })
}

export function defaultModelCeiling({ model, kind } = {}) {
  return MODEL_TRUST_TIERS[modelTrustTier({ model, kind })]
}

export function modelCeiling(config = {}, { model, kind, trustOverride } = {}) {
  return modelSpawnCeiling(config, { model, kind, trustOverride }).capability
}

export function modelSpawnCeiling(config = {}, { model, kind, trustOverride } = {}) {
  // Per-agent operator override (e.g. a trusted minimax raised above its model
  // default). Operator-gated in authorizeSpawn — this function trusts that the
  // caller already proved root before a trustOverride reached it.
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
export const SPAWN_PROFILES = {
  none: { capability: 'none', policy: 'cwd' },
  'read-only': { capability: 'read', policy: 'cwd' },
  ops: { capability: 'full', policy: 'unsandboxed' },
  'app-dev': { capability: 'full', policy: 'unsandboxed' },
  deploy: { capability: 'write', policy: 'cwd' },
  app: { capability: 'write', policy: 'cwd' },
  cwd: { capability: 'write', policy: 'cwd' },
  math: { capability: 'tlda-write', policy: 'tlda-projects' },
  'math-project': { capability: 'tlda-write', policy: 'tlda-projects' },
  'math-projects': { capability: 'tlda-write', policy: 'tlda-projects' },
  untrusted: { capability: 'write', policy: 'cwd' },
}

export const DEFAULT_SPAWN_PROFILE = 'cwd'
export const PRIVILEGE_OPERATIONS = ['read', 'write', 'spawn']

function emptyPrivilegeOperations() {
  const operations = {}
  for (const operation of PRIVILEGE_OPERATIONS) {
    operations[operation] = { allow: [], deny: [] }
  }
  return operations
}

function normalizePrivilegeOperation(value, lineNumber) {
  const operation = String(value || '').trim().toLowerCase()
  if (!PRIVILEGE_OPERATIONS.includes(operation)) {
    const suffix = lineNumber ? ` on line ${lineNumber}` : ''
    throw new Error(`unknown privilege operation "${value}"${suffix}`)
  }
  return operation
}

function normalizePrivilegeProfileName(value, lineNumber) {
  const name = String(value || '').trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    const suffix = lineNumber ? ` on line ${lineNumber}` : ''
    throw new Error(`invalid privilege profile name "${value}"${suffix}`)
  }
  return name
}

function addPrivilegeRule(profile, { operation, effect, zone, line }) {
  const rule = { operation, effect, zone, line }
  profile.rules.push(rule)
  profile.operations[operation][effect].push(zone)
}

export function compilePrivilegeProfiles(source, { sourcePath } = {}) {
  if (typeof source !== 'string') throw new Error('privilege profile source must be a string')
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
      const name = normalizePrivilegeProfileName(header[1], lineNumber)
      const key = name.toLowerCase()
      if (profiles[key]) throw new Error(`duplicate privilege profile "${name}" on line ${lineNumber}`)
      current = {
        type: 'privilege-set',
        name,
        operations: emptyPrivilegeOperations(),
        rules: [],
        ...(sourcePath ? { sourcePath } : {}),
      }
      profiles[key] = current
      continue
    }

    if (!current) throw new Error(`privilege rule before profile header on line ${lineNumber}`)
    const rule = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s+([+-])\s+(.+?)\s*$/)
    if (!rule) throw new Error(`invalid privilege rule on line ${lineNumber}: ${raw.trim()}`)
    const operation = normalizePrivilegeOperation(rule[1], lineNumber)
    const effect = rule[2] === '+' ? 'allow' : 'deny'
    const zone = rule[3].trim()
    if (!zone) throw new Error(`empty privilege zone on line ${lineNumber}`)
    addPrivilegeRule(current, { operation, effect, zone, line: lineNumber })
  }
  if (!Object.keys(profiles).length) throw new Error('privilege profile source contains no profile blocks')
  return {
    type: 'privilege-profile-bundle',
    profiles,
    ...(sourcePath ? { sourcePath } : {}),
  }
}

function selectCompiledPrivilegeProfile(bundle, requestedName = null) {
  const keys = Object.keys(bundle.profiles || {})
  if (!keys.length) throw new Error('compiled privilege bundle contains no profiles')
  if (requestedName) {
    const key = String(requestedName).trim().toLowerCase()
    const profile = bundle.profiles[key]
    if (!profile) throw new Error(`privilege profile "${requestedName}" not found`)
    return profile
  }
  if (keys.length === 1) return bundle.profiles[keys[0]]
  throw new Error('privilege profile source has multiple profiles; specify profile/name')
}

const BUILTIN_PRIVILEGE_PROFILE_SOURCE = `
profile app-dev:
  read + cwd
  write + cwd
  spawn + **
  read + ~/.config/tlda/fleet-daemon.log
  write + ~/.config/tlda/fleet-daemon.log
  read + ~/.config/tlda/fleet-daemon.pid
  write + ~/.config/tlda/fleet-daemon.pid
  read + ~/.config/tlda/fleet-daemon.lock
  write + ~/.config/tlda/fleet-daemon.lock

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

let builtinPrivilegeBundle = null

function builtinPrivilegeProfiles() {
  if (!builtinPrivilegeBundle) builtinPrivilegeBundle = compilePrivilegeProfiles(BUILTIN_PRIVILEGE_PROFILE_SOURCE, { sourcePath: 'builtin' })
  return builtinPrivilegeBundle
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

export function privilegeSetFromPolicy(policyValue, { name, cwd, project } = {}) {
  const policy = normalizeSpawnPolicy(policyValue)
  const zone = zoneForPolicy(policy, { cwd, project })
  const operations = emptyPrivilegeOperations()
  const rules = []
  if (policy.capability !== 'none') {
    const readRule = { operation: 'read', effect: 'allow', zone, line: null }
    rules.push(readRule)
    operations.read.allow.push(zone)
  }
  if (policy.capability !== 'none' && policy.capability !== 'read') {
    const writeRule = { operation: 'write', effect: 'allow', zone, line: null }
    rules.push(writeRule)
    operations.write.allow.push(zone)
  }
  if (policy.capability !== 'none') {
    const spawnRule = { operation: 'spawn', effect: 'allow', zone: '**', line: null }
    rules.push(spawnRule)
    operations.spawn.allow.push('**')
  }
  return {
    type: 'privilege-set',
    name: name || policy.name,
    operations,
    rules,
    projectedPolicy: policy,
    compiledFrom: 'spawn-policy',
  }
}

export function emptyPrivilegeSet({ name = 'none', projectedPolicy = 'none' } = {}) {
  return {
    type: 'privilege-set',
    name,
    operations: emptyPrivilegeOperations(),
    rules: [],
    projectedPolicy: normalizeSpawnPolicy(projectedPolicy, 'none'),
    compiledFrom: 'empty-privilege-set',
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

function clonePrivilegeSet(set) {
  const operations = emptyPrivilegeOperations()
  const rules = []
  for (const operation of PRIVILEGE_OPERATIONS) {
    for (const effect of ['allow', 'deny']) {
      for (const zone of set.operations?.[operation]?.[effect] || []) {
        operations[operation][effect].push(zone)
      }
    }
  }
  for (const rule of set.rules || []) rules.push({ ...rule })
  return { ...set, operations, rules }
}

function builtinPrivilegeProfile(name) {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  const profile = builtinPrivilegeProfiles().profiles[key]
  if (!profile) return null
  const cloned = clonePrivilegeSet(profile)
  cloned.projectedPolicy = normalizeSpawnPolicy(SPAWN_PROFILES[key] || 'write')
  cloned.compiledFrom = 'builtin-privilege-profile'
  return cloned
}

function intersectPrivilegePair(left, right) {
  const operations = emptyPrivilegeOperations()
  let rules = []
  for (const operation of PRIVILEGE_OPERATIONS) {
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
    type: 'privilege-set',
    name: `${left.name || 'left'}&${right.name || 'right'}`,
    operations,
    rules,
    compiledFrom: 'intersection',
  }
}

export function intersectPrivilegeSets(sets, { name = 'grant', projectedPolicy = null } = {}) {
  const normalized = sets.filter(Boolean).map(clonePrivilegeSet)
  if (!normalized.length) throw new Error('cannot intersect an empty privilege-set list')
  let current = normalized[0]
  for (const next of normalized.slice(1)) current = intersectPrivilegePair(current, next)
  current.name = name
  if (projectedPolicy) current.projectedPolicy = projectedPolicy
  return current
}

export function privilegeSetLte(left, right) {
  for (const operation of PRIVILEGE_OPERATIONS) {
    for (const zone of left.operations?.[operation]?.allow || []) {
      if (!(right.operations?.[operation]?.allow || []).some((candidate) => zoneContains(candidate, zone))) return false
    }
    for (const zone of right.operations?.[operation]?.deny || []) {
      if (!(left.operations?.[operation]?.deny || []).includes(zone)) return false
    }
  }
  return true
}

function looksLikePrivilegeSet(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.type === 'privilege-set'
    && value.operations
    && typeof value.operations === 'object'
}

function policyForPrivilegeSet(privileges, fallback = DEFAULT_AGENT_CAPABILITY) {
  if (privileges.projectedPolicy) return normalizeSpawnPolicy(privileges.projectedPolicy, fallback)
  const named = privileges.name ? firstKnownProfile(privileges.name) : null
  if (named) return normalizeProfileOrPolicyName(named)
  const write = privileges.operations?.write || {}
  const read = privileges.operations?.read || {}
  const hasWrite = (write.allow || []).length > 0
  const hasRead = (read.allow || []).length > 0
  return normalizeSpawnPolicy(hasWrite ? DEFAULT_AGENT_CAPABILITY : (hasRead ? 'read' : 'none'), fallback)
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
    if (SPAWN_PROFILES[name]) return name
  }
  return null
}

function configuredProjectProfileName(projectProfiles = {}, keys = []) {
  for (const key of keys) {
    if (!key) continue
    const configured = projectProfiles[key] ?? projectProfiles[String(key).toLowerCase()]
    const name = firstKnownProfile(configured)
    if (name) return name
  }
  return null
}

// Resolve which profile NAME a spawn should inherit. Precedence:
// the project record's own `profile` field → config.spawnPolicy.projectProfiles
// keyed by project name / sourceDir / cwd basename → built-in basename profile
// → DEFAULT_SPAWN_PROFILE. The daemon privilege ledger is the authority for
// caller grants; config.json must not invent a broad default profile.
export function resolveProjectProfileName(config = {}, { doc, project, cwd } = {}) {
  const policy = config.spawnPolicy || {}
  const projectProfiles = policy.projectProfiles || {}
  const sourceDir = project?.sourceDir || null
  const cwdMatchesProject = cwd && sourceDir && pathInside(cwd, sourceDir)
  return firstKnownProfile(project?.profile)
    || configuredProjectProfileName(projectProfiles, [
      doc,
      project?.name,
      sourceDir,
      pathBasename(sourceDir),
      cwd,
      pathBasename(cwd),
    ])
    || firstKnownProfile(
      cwdMatchesProject ? pathBasename(sourceDir) : null,
      pathBasename(cwd)
    )
    || DEFAULT_SPAWN_PROFILE
}

// The profile a spawn inherits, as a normalized spawn policy. This becomes the
// requested capability when the caller does not request one explicitly — the
// default fence. authorizeSpawn still bounds it by the model ceiling and the
// caller's own authority.
export function resolveProjectProfile(config = {}, { doc, project, cwd } = {}) {
  const name = resolveProjectProfileName(config, { doc, project, cwd })
  return { ...normalizeSpawnPolicy(SPAWN_PROFILES[name]), name }
}

function privilegeSetForProfileName(name, policy, { cwd, project } = {}) {
  const builtinProfile = builtinPrivilegeProfile(name)
  if (builtinProfile) return builtinProfile
  return privilegeSetFromPolicy(policy, { name: policy.name, cwd, project })
}

function materializePrivilegeZone(zone, { cwd, project } = {}) {
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

function materializePrivilegeSet(privilegeSet, { cwd, project } = {}) {
  if (!privilegeSet || typeof privilegeSet !== 'object') return privilegeSet
  const operations = emptyPrivilegeOperations()
  const rules = []
  for (const operation of PRIVILEGE_OPERATIONS) {
    for (const effect of ['allow', 'deny']) {
      for (const zone of privilegeSet.operations?.[operation]?.[effect] || []) {
        const materialized = materializePrivilegeZone(zone, { cwd, project })
        if (!materialized) continue
        operations[operation][effect].push(materialized)
        rules.push({ operation, effect, zone: materialized, line: null })
      }
    }
  }
  return {
    ...privilegeSet,
    operations,
    rules,
    materializedFrom: privilegeSet.name || privilegeSet.materializedFrom || 'privilege-set',
  }
}

function normalizeProfileOrPolicyName(value) {
  const name = String(value || '').trim().toLowerCase()
  if (SPAWN_PROFILES[name]) return { ...normalizeSpawnPolicy(SPAWN_PROFILES[name]), name }
  return normalizeSpawnPolicy(value)
}

function withPrivilegeSet(policy, privilegeSet) {
  return {
    ...policy,
    privilegeSet,
  }
}

export function normalizeRequestedPrivileges(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizeRequestedPrivileges(fallback)
  }
  if (typeof value === 'string') {
    const builtinProfile = builtinPrivilegeProfile(value)
    if (builtinProfile) {
      const policy = policyForPrivilegeSet(builtinProfile, fallback || DEFAULT_AGENT_CAPABILITY)
      return withPrivilegeSet({ ...policy, name: builtinProfile.name }, builtinProfile)
    }
    const policy = normalizeProfileOrPolicyName(value)
    return withPrivilegeSet(policy, privilegeSetFromPolicy(policy, { name: policy.name }))
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unknown privilege request "${value}"`)
  }
  if (looksLikePrivilegeSet(value)) {
    const policy = policyForPrivilegeSet(value, fallback || DEFAULT_AGENT_CAPABILITY)
    return withPrivilegeSet(policy, value)
  }
  if (value.capability) {
    const policy = normalizeSpawnPolicy(value)
    return withPrivilegeSet(policy, privilegeSetFromPolicy(policy, { name: policy.name }))
  }
  if (value.type === 'privilege-profile-bundle') {
    const profile = selectCompiledPrivilegeProfile(value, value.profile || value.preset || value.name)
    const policy = policyForPrivilegeSet(profile, fallback || DEFAULT_AGENT_CAPABILITY)
    return withPrivilegeSet(policy, profile)
  }
  if (typeof value.source === 'string') {
    const bundle = compilePrivilegeProfiles(value.source, { sourcePath: value.sourcePath })
    const profile = selectCompiledPrivilegeProfile(bundle, value.profile || value.preset || value.name)
    const policy = policyForPrivilegeSet(profile, fallback || DEFAULT_AGENT_CAPABILITY)
    return withPrivilegeSet(policy, profile)
  }
  const named = value.profile || value.preset || value.name
  if (named) {
    const builtinProfile = builtinPrivilegeProfile(named)
    if (builtinProfile) {
      const policy = policyForPrivilegeSet(builtinProfile, fallback || DEFAULT_AGENT_CAPABILITY)
      return withPrivilegeSet({ ...policy, name: builtinProfile.name }, builtinProfile)
    }
    const policy = normalizeProfileOrPolicyName(named)
    return withPrivilegeSet(policy, privilegeSetFromPolicy(policy, { name: policy.name }))
  }
  throw new Error('unknown privilege request; expected a named profile, compiled privilege set, or profile source')
}

// The operator (human, or the server owner identity) is root: never fenced, can
// confer any capability up to and including destructive full, and is the ONLY
// caller permitted to raise a model's trust ceiling per-agent. Every agent, no
// matter how trusted its model, resolves here as non-operator — so an agent can
// never self-escalate.
export function isOperator(caller, { serverOwnerId } = {}) {
  return !!(caller?.human || (serverOwnerId && caller?.id === serverOwnerId))
}

// Interpret a stored spawnPolicy blob into one of the named rungs. The conferral
// level is the stored CAPABILITY, not the stored region: the register handler
// used to shallow-merge spawnPolicy across writers and the global fence-off
// stamped `unsandboxed` onto many rows, corrupting the REGION — but the
// capability field still reflects what the agent was spawned with. So we honor
// the capability and DERIVE the region (CAPABILITY_REGION), which both (a)
// repairs the corrupted region by tightening it back to the rung's real scope,
// and (b) never confers above the stored rung — no auto-promotion on a guess.
//
// The one place the stored region carries meaning is the legacy write /
// tlda-write split: both were `workspace-write`, distinguished only by region
// (`cwd` vs `tlda-projects`). So for a legacy workspace-write blob the region
// `tlda-projects` (and only that) means tlda-write; any other region (cwd, the
// corrupted unsandboxed, or absent) means plain write. Returns a rung, or null
// for an unrecognized capability string.
//
// Worked outcomes on the live Fly population: mathchat2 `{read-only, unsandboxed}`
// → `read` (honor read; the corrupted region is ignored) — Skip's call: a
// corrupted math agent stays read under the code default and is promoted to
// write only by the operator-gated sweep. The ~60 `{workspace-write*, unsandboxed}`
// fence-off rows → `write` (honor write; region repaired to cwd) — NOT demoted
// to read. A legacy `{workspace-write, tlda-projects}` → `tlda-write` (scope
// preserved).
function storedConferralRung(stored) {
  const blob = typeof stored === 'string' ? { capability: stored } : stored
  if (!blob || typeof blob !== 'object' || blob.capability == null) return null
  return legacyRung(blob.capability, blob.policy)
}

// Conferral resolution. By what the agent's stored spawnPolicy is:
//   • absent             → DEFAULT_AGENT_CAPABILITY (write). The historical
//                          default for the ~495 never-assigned agents; unchanged.
//   • recognized rung    → honored (read reviewers stay read; write agents stay
//                          write; tlda scope preserved; corrupted region repaired).
//   • unrecognized blob  → `read`. Never trusted to confer up; the correct
//                          capability is restored only by the operator-gated,
//                          role-aware re-projection sweep (Skip's call).
export function callerSpawnPolicy(caller, { serverOwnerId } = {}) {
  if (isOperator(caller, { serverOwnerId })) return normalizeSpawnPolicy(ROOT_CAPABILITY)
  const stored = caller?.metadata?.spawnPolicy
  if (stored == null) return normalizeSpawnPolicy(DEFAULT_AGENT_CAPABILITY)
  return normalizeSpawnPolicy(storedConferralRung(stored) || 'read')
}

export function callerCapability(caller, { serverOwnerId } = {}) {
  return callerSpawnPolicy(caller, { serverOwnerId }).capability
}

// Coerce a (possibly corrupted or legacy) stored spawnPolicy blob into a
// coherent four-name rung policy for ATOMIC persistence. The register handler
// used to shallow-merge spawnPolicy fields across writers, minting incoherent
// blobs like {read-only, unsandboxed}; persisting the coherent rung instead
// means no new corruption can form. This repairs the REPRESENTATION only — the
// conferral level (the rung) is unchanged, so it never promotes or demotes an
// agent (mathchat2's {read-only, unsandboxed} stores as {read, cwd}, still read;
// a real change of capability is the operator-gated sweep, not this). Returns
// the coherent policy, or null when there is nothing storable.
export function coherentSpawnPolicy(stored) {
  if (stored == null) return null
  const rung = storedConferralRung(stored)
  if (!rung) return null
  const netOff = typeof stored === 'object' && !Array.isArray(stored) && stored.network === false
  return { ...normalizeSpawnPolicy(rung), ...(netOff ? { network: false } : {}) }
}

export function projectCapabilityToMode(capability, explicitMode = null) {
  // This is only the non-fenced default projection. The spawn launch helper in
  // bin/lib/spawn/permissions.mjs must make the final decision because fenced
  // launches need Claude's classifier bypassed and the emergency off-switches
  // TLDA_DISABLE_PERMISSION_CLASSIFIER / agentSandbox.disablePermissionsClassifier
  // intentionally force that bypass even without a fence.
  const cap = normalizeCapability(capability)
  if (explicitMode) return explicitMode
  if (cap === 'full') return 'bypassPermissions'
  return 'default'
}

export function authorizeSpawn({ caller, requestedCapability, model, kind, trustOverride, config = {}, serverOwnerId }) {
  if (!caller?.id) throw new Error('spawn caller identity is required')
  // A per-agent trust override raises (or sets) the model ceiling for this one
  // spawn — the operator-only exception that lets a trusted minimax sit above
  // its model default. Only the operator may supply it; an agent presenting one
  // is trying to self-escalate, which is refused outright. This is the ONLY
  // refusal authorizeSpawn ever makes.
  if (trustOverride != null && trustOverride !== '' && !isOperator(caller, { serverOwnerId })) {
    const err = new Error('trust override is operator-only; agents cannot raise their own ceiling')
    err.code = 'SPAWN_TRUST_OVERRIDE_FORBIDDEN'
    throw err
  }
  const requestedPolicy = normalizeSpawnPolicy(requestedCapability, DEFAULT_AGENT_CAPABILITY)
  const callerPolicy = callerSpawnPolicy(caller, { serverOwnerId })
  const ceilingPolicy = modelSpawnCeiling(config, { model, kind, trustOverride })
  // Skip's rule: a spawn NEVER fails on capability grounds. The granted policy is
  // the meet (greatest lower bound) of what was asked for, the caller's own
  // authority, and the model's trust ceiling — clamp down and hand it off, never
  // refuse. A `full` agent spawning a deepseek yields a deepseek-narrow child
  // (the model ceiling clamps it), not an error — exactly "lock down dangerous
  // agents" expressed as a clamp.
  const grantedPolicy = meetSpawnPolicies([requestedPolicy, callerPolicy, ceilingPolicy])
  return {
    requestedCapability: grantedPolicy.capability,
    requestedPolicy: grantedPolicy,
    grantedPolicy,
    callerCapability: callerPolicy.capability,
    callerPolicy,
    modelCeiling: ceilingPolicy.capability,
    modelCeilingPolicy: ceilingPolicy,
  }
}

export function resolveSpawnGrant({
  requestedCapability,
  requestedPrivileges,
  callerRung,
  requester,
  spawnerPolicy: explicitSpawnerPolicy,
  spawnerPrivilegeSet: explicitSpawnerPrivilegeSet,
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
    : normalizeSpawnPolicy(callerRung, ROOT_CAPABILITY)
  const projectPrivilegeSet = privilegeSetForProfileName(projectPolicy.name, projectPolicy, { cwd, project })
  const requestedPolicy = requestedPrivileges || requestedCapability
    ? normalizeRequestedPrivileges(requestedPrivileges || requestedCapability, DEFAULT_AGENT_CAPABILITY)
    : withPrivilegeSet(projectPolicy, projectPrivilegeSet)
  const grantedPolicy = meetSpawnPolicies([requestedPolicy, modelPolicy, spawnerPolicy])
  const modelPrivilegeSet = privilegeSetFromPolicy(modelPolicy, { name: modelPolicy.name, cwd, project })
  const spawnerPrivilegeSet = explicitSpawnerPrivilegeSet
    ? materializePrivilegeSet(explicitSpawnerPrivilegeSet, { cwd, project })
    : privilegeSetFromPolicy(spawnerPolicy, { name: spawnerPolicy.name, cwd, project })
  if (!(spawnerPrivilegeSet?.operations?.spawn?.allow || []).length) {
    const err = new Error('spawner lacks spawn privilege')
    err.code = 'SPAWN_PRIVILEGE_DENIED'
    throw err
  }
  const requestedPrivilegeSet = requestedPolicy.privilegeSet
    || (requestedPrivileges || requestedCapability
      ? privilegeSetFromPolicy(requestedPolicy, { name: requestedPolicy.name, cwd, project })
      : projectPrivilegeSet)
  const grantedPrivilegeSet = intersectPrivilegeSets([
    materializePrivilegeSet(requestedPrivilegeSet, { cwd, project }),
    modelPrivilegeSet,
    spawnerPrivilegeSet,
  ], { name: grantedPolicy.name, projectedPolicy: grantedPolicy })
  return {
    requestedCapability: requestedPolicy.capability,
    requestedPolicy,
    requestedPrivileges: requestedPrivilegeSet,
    requestedPrivilegeSet,
    callerCapability: spawnerPolicy.capability,
    callerPolicy: spawnerPolicy,
    spawnerCapability: spawnerPolicy.capability,
    spawnerPolicy,
    projectCapability: projectPolicy.capability,
    projectPolicy,
    modelCapability: modelPolicy.capability,
    modelPolicy,
    machineAllowedCapability: grantedPolicy.capability,
    machineAllowedPolicy: grantedPolicy,
    grantedCapability: grantedPolicy.capability,
    grantedPolicy,
    grantedPrivileges: grantedPrivilegeSet,
    grantedPrivilegeSet,
  }
}
