import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// Skip's ONE permission vocabulary — the coarse permission NAMES. This is the
// only permission vocabulary tlda owns; there is NO machine vocabulary
// (workspace-*, *-no-net, full-access) on any tlda surface. These names are a
// COARSE LABEL for a region set, not a rank ladder: the real authority is the
// region-set intersection (intersectPermissionSets); the name is derived FROM
// the region set for display and for the sandbox-region
// selection downstream. The filesystem REGION each name maps to is PART OF THE
// NAME (tlda-write = write across all tlda projects), not a second axis. "no-net"
// is not a name — net is always on (Skip: "literally every type of agent should
// be able to use the Internet"); it survives only as a never-typed
// `network:false` modifier. The single foreign string that survives is Codex's
// own sandbox API value, mapped at the fleet-spawn boundary, not here.
const PERMISSION_NAMES = new Set(['none', 'read', 'write', 'tlda-write', 'full'])

export function normalizePermission(value) {
  if (value == null || value === '') {
    throw new Error('spawn permission is required')
  }
  const raw = String(value).trim().toLowerCase()
  if (!PERMISSION_NAMES.has(raw)) {
    throw new Error(`unknown spawn permission "${value}"`)
  }
  return raw
}

// Spawn policy is a resolved daemon-config object. The code validates it but does
// not infer a region from a permission name.
export function normalizeSpawnPolicy(value) {
  if (value == null || value === '') {
    throw new Error('spawn policy is required')
  }

  if (typeof value === 'string') {
    throw new Error('spawn policy must include a configured permission and region')
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unknown spawn policy "${value}"`)
  }

  const permission = normalizePermission(value.permission)
  const policy = String(value.policy || '').trim().toLowerCase()
  if (!policy) throw new Error('spawn policy region is required')
  return {
    name: value.name || permission,
    permission,
    policy,
    category: 'write-scope',
    ...(value.network === false ? { network: false } : {}),
  }
}

// Build a region set: read == write == the zone, spawn open. The one shape used for
// model ceilings, bare profile-name fallbacks, and the machine (root) spawner set.
function regionPermissionSet(zone, { name, cwd, project } = {}) {
  const operations = emptyPermissionOperations()
  const rules = []
  for (const op of ['read', 'write']) {
    operations[op].allow.push(zone)
    rules.push({ operation: op, effect: 'allow', zone, line: null })
  }
  operations.spawn.allow.push('**')
  rules.push({ operation: 'spawn', effect: 'allow', zone: '**', line: null })
  return materializePermissionSet(
    { type: 'permission-set', name: name || `region:${zone}`, operations, rules, compiledFrom: 'region' },
    { cwd, project },
  )
}

// The whole machine — the spawner set for root/operator/direct spawns.
function allMachineSet(name = 'machine') {
  return regionPermissionSet('**', { name })
}

// The fence REGION a set covers, read off its write zones — NOT a level. A
// machine-covering write ⇒ unsandboxed; the literal tlda-projects token ⇒
// tlda-projects; anything else (bounded write, read-only, or empty) ⇒ cwd. This is
// the only thing derived from the region set, and it's a region scope for the lease,
// never a rank.
export function regionScopeFromSet(set) {
  const writeAllow = set.operations?.write?.allow || []
  return writeAllow.some(isMachineZone)
    ? 'unsandboxed'
    : writeAllow.some((z) => String(z).trim() === 'tlda-projects')
      ? 'tlda-projects'
      : 'cwd'
}

// Stored grants use only current fence region names. Older permission vocabulary
// must be migrated before startup; it is not interpreted at runtime.
const REGION_SCOPES = new Set(['cwd', 'tlda-projects', 'unsandboxed', 'no-dev'])
function regionOf(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (REGION_SCOPES.has(s)) return s
  return null
}
export function normalizeRegionPolicy(value) {
  if (value == null || value === '') throw new Error('spawn policy region is required')
  if (typeof value === 'string') {
    const policy = regionOf(value)
    if (!policy) throw new Error(`unknown spawn policy region "${value}"`)
    return { policy }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const policy = regionOf(value.policy)
    if (!policy) throw new Error('spawn policy region is required')
    return {
      policy,
      ...(value.network === false ? { network: false } : {}),
    }
  }
  throw new Error(`unknown spawn policy region "${value}"`)
}

// Optional model cap from the resolved daemon model spec. There is no code-owned
// trust tier fallback here: absent daemon cap, this operand is identity.
function modelCeilingPermissionSet(config = {}, { modelCap, cwd, project } = {}) {
  if (!modelCap) return allMachineSet('model:uncapped')
  const profile = configuredPermissionProfile(config, modelCap)
  if (profile) return materializePermissionSet(profile, { cwd, project })
  return regionPermissionSet(modelCap, { name: `model:${modelCap}`, cwd, project })
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
//   app-dev   — dev + tester: code, git, dev-server, browser, network, according
//               to the daemon.yaml profile named app-dev.
//   math      — write across all tlda/math projects (tlda-write).
//   untrusted — write only its own project (cwd); never across projects, never
//               machine-level. Same lane as app; the trust difference is carried
//               by the model ceiling, not the lane.
export const DEFAULT_SPAWN_PROFILE = null
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

function zoneForPolicy(policy, { cwd, project } = {}) {
  if (policy.policy === 'unsandboxed') return '**'
  const base = policy.policy === 'tlda-projects'
    ? (project?.sourceDir || cwd || 'tlda-projects')
    : (cwd || policy.policy)
  if (base === 'cwd' || base === 'tlda-projects') return base
  const resolved = normalizedPath(base)
  return `${resolved || base}/**`
}

export function emptyPermissionSet({ name = 'none', projectedPolicy } = {}) {
  if (!projectedPolicy) throw new Error('empty permission set requires a resolved spawn policy')
  return {
    type: 'permission-set',
    name,
    operations: emptyPermissionOperations(),
    rules: [],
    projectedPolicy: normalizeSpawnPolicy(projectedPolicy),
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

function configuredPermissionProfiles(config = {}) {
  const profiles = config.spawnPolicy?.permissionProfiles || {}
  return profiles && typeof profiles === 'object' && !Array.isArray(profiles) ? profiles : {}
}

function configuredPermissionProfile(config = {}, name) {
  const key = String(name || '').trim()
  if (!key) return null
  const profiles = configuredPermissionProfiles(config)
  const profile = profiles[key]
  if (!looksLikePermissionSet(profile)) return null
  const cloned = clonePermissionSet(profile)
  cloned.compiledFrom = cloned.compiledFrom || 'daemon-config-profile'
  return cloned
}

function firstConfiguredProfile(config = {}, ...values) {
  const configured = configuredPermissionProfiles(config)
  for (const value of values) {
    const name = String(value || '').trim()
    if (!name) continue
    if (configured[name]) return name
  }
  return null
}

export function exactConfiguredPermissionProfile(permissionSet, config = {}, preferred = null) {
  const profiles = configuredPermissionProfiles(config)
  const candidates = preferred && profiles[preferred]
    ? [[preferred, profiles[preferred]], ...Object.entries(profiles).filter(([name]) => name !== preferred)]
    : Object.entries(profiles)
  for (const [name, profile] of candidates) {
    if (permissionSetLte(permissionSet, profile) && permissionSetLte(profile, permissionSet)) return name
  }
  return null
}

function configuredProjectProfileName(config = {}, projectProfiles = {}, keys = []) {
  for (const key of keys) {
    if (!key) continue
    const configured = projectProfiles[key] ?? projectProfiles[String(key).toLowerCase()]
    const name = firstConfiguredProfile(config, configured)
    if (name) return name
  }
  return null
}

// Resolve which profile NAME a spawn should inherit. Precedence:
// the project record's own `profile` field → config.spawnPolicy.projectProfiles
// keyed by project name / sourceDir / cwd basename → configured default profile.
// The daemon permission ledger is the authority for caller grants; config.json
// must not invent a broad default profile.
export function resolveProjectProfileName(config = {}, { doc, project, cwd } = {}) {
  const policy = config.spawnPolicy || {}
  const projectProfiles = policy.projectProfiles || {}
  const sourceDir = project?.sourceDir || null
  const cwdMatchesProject = cwd && sourceDir && pathInside(cwd, sourceDir)
  return firstConfiguredProfile(config, project?.profile)
    || configuredProjectProfileName(config, projectProfiles, [
      doc,
      project?.name,
      sourceDir,
      pathBasename(sourceDir),
      cwd,
      pathBasename(cwd),
    ])
    || firstConfiguredProfile(config,
      cwdMatchesProject ? pathBasename(sourceDir) : null,
      pathBasename(cwd)
    )
    || firstConfiguredProfile(config, policy.defaultProfile)
    || DEFAULT_SPAWN_PROFILE
}

// The profile a spawn inherits, as a normalized spawn policy. This becomes the
// requested permission when the caller does not request one explicitly — the
// default fence. resolveSpawnGrant still bounds it, via the region-set
// intersection, by the model ceiling and the spawner's own authority.
function permissionSetForProfileName(name, { cwd, project, config } = {}) {
  const key = String(name || '').trim()
  if (!key) {
    throw new Error('no configured project permission profile')
  }
  const configured = configuredPermissionProfile(config, name)
  if (configured) return configured
  throw new Error(`unknown permission profile "${name}"`)
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

function unknownPermissionProfileError(config = {}, name) {
  const configured = Object.keys(configuredPermissionProfiles(config)).sort()
  return new Error(`unknown permission profile "${name}". Profiles: ${configured.join(', ') || '(none configured)'}`)
}

function explicitPermissionProfileRequest(config = {}, value, fallback = null) {
  const named = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' && !Array.isArray(value) && !value.permission && !value.source && !looksLikePermissionSet(value)
      ? (value.profile || value.preset || value.name)
      : null)
  if (!named) return null
  const name = String(named || '').trim()
  if (!name) return null
  const configured = configuredPermissionProfile(config, name)
  if (configured) {
    const policy = { name, policy: regionScopeFromSet(configured) }
    return { ...policy, permissionSet: configured }
  }
  throw unknownPermissionProfileError(config, name)
}

// The operator (human, or the server owner identity) is root: never fenced, can
// confer any permission up to and including destructive full, and is the ONLY
// caller permitted to raise a model's trust ceiling per-agent. Every agent, no
// matter how trusted its model, resolves here as non-operator — so an agent can
// never self-escalate.
export function resolveSpawnGrant({
  permissionRequest,
  spawnerPermissionSet: explicitSpawnerPermissionSet,
  spawnerPermissionProfile = null,
  model,
  kind,
  modelCap,
  config = {},
  doc,
  project,
  cwd,
} = {}) {
  // Three region sets, intersected. That is the whole grant — the only logic is the
  // intersection of regions (project ∩ model-ceiling ∩ spawner). The intersected
  // allow/deny path set IS the fence; nothing ranks or labels it.
  // An explicit --permissions request: a named daemon profile (its region set) or an
  // inline permission set. Absent → the project's default profile.
  const explicitPermissions = permissionRequest
    ? explicitPermissionProfileRequest(config, permissionRequest)
    : null
  const projectPermissionSet = !explicitPermissions
    ? permissionSetForProfileName(resolveProjectProfileName(config, { doc, project, cwd }), { cwd, project, config })
    : null
  const requestedProfile = explicitPermissions?.name
    || (!explicitPermissions ? resolveProjectProfileName(config, { doc, project, cwd }) : null)
  const requestedSet = materializePermissionSet(
    explicitPermissions?.permissionSet || projectPermissionSet,
    { cwd, project },
  )

  const modelPermissionProfile = firstConfiguredProfile(config, modelCap)
  const modelPermissionSet = modelCeilingPermissionSet(config, { modelCap, cwd, project })
  if (!explicitSpawnerPermissionSet) throw new Error('spawner permission set is required from the daemon ledger')
  const spawnerPermissionSet = materializePermissionSet(explicitSpawnerPermissionSet, { cwd, project })
  const configuredSpawnerProfile = firstConfiguredProfile(config, spawnerPermissionProfile)

  const permissionSet = intersectPermissionSets([
    requestedSet,
    modelPermissionSet,
    spawnerPermissionSet,
  ], { name: 'grant' })
  const resolvedGrantIdentity = permissionRequest
    ? resolvedExplicitPermissionGrantIdentity({
        requestedProfile,
        requestedSet,
        modelPermissionProfile,
        modelPermissionSet,
        spawnerPermissionProfile: configuredSpawnerProfile,
        spawnerPermissionSet,
        permissionSet,
        config,
        cwd,
        project,
      })
    : exactConfiguredPermissionProfile(permissionSet, config, requestedProfile)
  const permissionProfile = typeof resolvedGrantIdentity === 'string' ? resolvedGrantIdentity : null
  const permissionIntersection = resolvedGrantIdentity?.type === 'permission-intersection'
    ? resolvedGrantIdentity
    : null
  // The grant carries the configured profile identity separately from the fence scope.
  const spawnPolicy = {
    policy: regionScopeFromSet(permissionSet),
  }
  permissionSet.projectedPolicy = spawnPolicy
  return {
    spawnPolicy,
    permissionSet,
    permissionProfile,
    ...(permissionIntersection ? { permissionIntersection } : {}),
  }
}

export function resolveDirectSpawnGrant(options = {}) {
  return resolveSpawnGrant(options)
}

function profileSet(config, name, { cwd, project } = {}) {
  return materializePermissionSet(configuredPermissionProfile(config, name), { cwd, project })
}

function samePermissionSet(left, right) {
  return !!(left && right && permissionSetLte(left, right) && permissionSetLte(right, left))
}

function strictlyClamps(clampSet, baseSet) {
  return !!(clampSet && baseSet && permissionSetLte(clampSet, baseSet) && !permissionSetLte(baseSet, clampSet))
}

function resolvedExplicitPermissionGrantIdentity({
  requestedProfile,
  requestedSet,
  modelPermissionProfile,
  modelPermissionSet,
  spawnerPermissionProfile,
  spawnerPermissionSet,
  permissionSet,
  config,
  cwd,
  project,
} = {}) {
  let chosenProfile = firstConfiguredProfile(config, requestedProfile)
  let chosenSet = chosenProfile ? profileSet(config, chosenProfile, { cwd, project }) : null

  const modelProfileSet = modelPermissionProfile ? profileSet(config, modelPermissionProfile, { cwd, project }) : null
  const spawnerProfileSet = spawnerPermissionProfile ? profileSet(config, spawnerPermissionProfile, { cwd, project }) : null

  if (modelPermissionProfile && strictlyClamps(modelProfileSet || modelPermissionSet, chosenSet || requestedSet)) {
    chosenProfile = modelPermissionProfile
    chosenSet = modelProfileSet || modelPermissionSet
  }
  if (spawnerPermissionProfile && strictlyClamps(spawnerProfileSet || spawnerPermissionSet, chosenSet || requestedSet)) {
    chosenProfile = spawnerPermissionProfile
    chosenSet = spawnerProfileSet || spawnerPermissionSet
  }

  if (!chosenProfile) {
    throw new Error('explicit permission request resolved to an anonymous grant; refusing to persist without a configured permission profile')
  }

  if (chosenSet && samePermissionSet(permissionSet, chosenSet)) {
    return chosenProfile
  }

  const intersection = structuredPermissionIntersection({
    requestedProfile,
    modelPermissionProfile,
    spawnerPermissionProfile,
    permissionSet,
  })
  if (intersection) return intersection

  throw new Error(`explicit permission request for "${requestedProfile || '(unknown)'}" resolved to an anonymous clamped grant; refusing to persist without a configured permission profile`)
}

function structuredPermissionIntersection({
  requestedProfile,
  modelPermissionProfile,
  spawnerPermissionProfile,
  permissionSet,
} = {}) {
  const profiles = [
    requestedProfile,
    modelPermissionProfile,
    spawnerPermissionProfile,
  ].map((name) => String(name || '').trim()).filter(Boolean)
  const uniqueProfiles = [...new Set(profiles)]
  if (uniqueProfiles.length < 2) return null
  return {
    type: 'permission-intersection',
    profiles: uniqueProfiles,
    permissionSet,
    provenance: {
      requestedProfile: requestedProfile || null,
      modelPermissionProfile: modelPermissionProfile || null,
      spawnerPermissionProfile: spawnerPermissionProfile || null,
    },
  }
}
