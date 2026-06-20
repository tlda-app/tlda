import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SPAWN_CAPABILITIES = [
  'read-only',
  'workspace-write-no-net',
  'workspace-write',
  'full-access',
]

// The four named fence configurations are the BUILT-IN DEFAULTS. The operator
// owns them and may override or add to them in the fence config file
// (~/.config/tlda/fence.json, key "policies"; or $TLDA_FENCE_CONFIG). That FILE
// is the source of truth — this map is only the fallback when it is absent, so
// behavior with no file is identical to before. Net (the internet) is ON for
// every policy via the `workspace-write` capability: there is NO internet
// sandbox in the defaults. To net-fence a policy, set its capability to
// `workspace-write-no-net` in the config file — the one opt-in net restriction.
const BUILTIN_SPAWN_POLICY_OPTIONS = {
  read: { capability: 'read-only', policy: 'cwd', category: 'write-scope' },
  write: { capability: 'workspace-write', policy: 'cwd', category: 'write-scope' },
  'tlda-write': { capability: 'workspace-write', policy: 'tlda-projects', category: 'write-scope' },
  full: { capability: 'full-access', policy: 'unsandboxed', category: 'write-scope' },
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
  for (const [name, def] of Object.entries(loadFenceConfigPolicies())) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) continue
    const base = merged[name] || { category: 'write-scope' }
    merged[name] = {
      capability: def.capability ?? base.capability,
      // `writeScope` is the operator-facing name for the filesystem policy.
      policy: def.policy ?? def.writeScope ?? base.policy,
      category: def.category ?? base.category ?? 'write-scope',
    }
  }
  return merged
}

export const SPAWN_POLICY_OPTIONS = buildSpawnPolicyOptions()

const CAPABILITY_RANK = new Map(SPAWN_CAPABILITIES.map((cap, idx) => [cap, idx]))
const POLICY_RANK = new Map([
  ['cwd', 0],
  ['tlda-projects', 1],
  ['unsandboxed', 2],
])

export const DEFAULT_AGENT_CAPABILITY = 'workspace-write'
export const ROOT_CAPABILITY = 'full-access'

const CAPABILITY_DEFAULT_POLICY = {
  'read-only': 'cwd',
  'workspace-write-no-net': 'cwd',
  'workspace-write': 'cwd',
  'full-access': 'unsandboxed',
}

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
  // Migration tolerance: agents spawned before the `+net` rename carry
  // `workspace-write+net` in their stored metadata. Net is the default now, so
  // the suffix is meaningless — strip it to the current name. Remove this once
  // no live agent's metadata still holds the old spelling (they update on
  // respawn). Without it, callerCapability() throws on those agents and they
  // can't spawn children.
  const migrated = raw === 'workspace-write+net' ? 'workspace-write' : raw
  const cap = resolveSpawnPolicyOption(migrated)?.capability || migrated
  if (!CAPABILITY_RANK.has(cap)) {
    throw new Error(`unknown spawn capability "${value}"`)
  }
  return cap
}

export function normalizeSpawnPolicy(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizeSpawnPolicy(fallback)
  }

  if (typeof value === 'string') {
    const option = resolveSpawnPolicyOption(value)
    if (option) return normalizeSpawnPolicy(option)
    const capability = normalizeCapability(value)
    return {
      name: null,
      capability,
      policy: CAPABILITY_DEFAULT_POLICY[capability],
      category: 'write-scope',
    }
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`unknown spawn policy "${value}"`)
  }

  const option = value.name ? resolveSpawnPolicyOption(value.name) : null
  const capability = normalizeCapability(value.capability || option?.capability)
  const policy = String(value.policy || option?.policy || CAPABILITY_DEFAULT_POLICY[capability] || '').trim().toLowerCase()
  if (!POLICY_RANK.has(policy)) {
    throw new Error(`unknown spawn filesystem policy "${value.policy}"`)
  }
  return {
    name: option?.name || value.name || null,
    capability,
    policy,
    category: value.category || option?.category || 'write-scope',
    ...(Object.hasOwn(value, 'network') ? { network: !!value.network } : {}),
  }
}

export function capabilityLte(left, right) {
  const a = normalizeCapability(left)
  const b = normalizeCapability(right)
  return CAPABILITY_RANK.get(a) <= CAPABILITY_RANK.get(b)
}

export function spawnPolicyLte(left, right) {
  const a = normalizeSpawnPolicy(left)
  const b = normalizeSpawnPolicy(right)
  if (!capabilityLte(a.capability, b.capability)) return false
  return POLICY_RANK.get(a.policy) <= POLICY_RANK.get(b.policy)
}

// Harness inference. The harness (claude / codex / goose) is plumbing — HOW a
// model is run — and is used only for the optional `familyCeilings` config knob
// and harness-only fallbacks. It is NOT what governs the trust ceiling; the
// MODEL does (see modelTrustTier). goose is a harness, not a trust level.
export function modelFamily({ model, kind } = {}) {
  const k = String(kind || '').toLowerCase()
  const m = String(model || '').toLowerCase()
  if (k) return k
  if (!m) return 'goose'
  if (m.includes('/')) return 'goose'
  if (m.startsWith('claude-') || ['opus', 'opus45', 'opus46', 'opus47', 'opus48', 'fable', 'fable5', 'sonnet', 'haiku'].includes(m)) return 'claude'
  if (m.startsWith('gpt-') || m.startsWith('o') || m.includes('openai')) return 'gpt'
  if (m.includes('deepseek') || m.includes('qwen') || m.includes('kimi') || m.includes('glm') || m.includes('minimax')) return 'goose'
  return 'unknown'
}

// Model trust tiers — keyed on the MODEL identity, NOT the harness (Skip 06-19:
// "ceiling keyed on the model, not the harness"). The harness decides how a
// model runs; the model decides how much authority an operator could ever grant
// it. goose running minimax and goose running deepseek share a harness but sit
// at different tiers, which the old harness-family lumping got wrong.
//
//   full     — closed frontier models we trust fully (claude, gpt/openai):
//              up to full-access / unsandboxed.
//   elevated — trusted-but-bounded open models (minimax): write across all tlda
//              projects + net; raisable to full per-agent by the operator.
//   narrow   — untrusted open models (deepseek, qwen, kimi, glm) and any
//              unrecognized model: write only their own cwd project + net, never
//              across projects and never machine-level. Safe by construction —
//              a tlda project is versioned on build, so any bad write recovers.
export const MODEL_TRUST_TIERS = {
  full: { capability: 'full-access', policy: 'unsandboxed' },
  elevated: { capability: 'workspace-write', policy: 'tlda-projects' },
  narrow: { capability: 'workspace-write', policy: 'cwd' },
}

const CLAUDE_MODEL_NAMES = new Set(['opus', 'opus45', 'opus46', 'opus47', 'opus48', 'fable', 'fable5', 'sonnet', 'haiku'])

function isClaudeModel(m) {
  return m.startsWith('claude-') || CLAUDE_MODEL_NAMES.has(m)
}

function isOpenAiModel(m) {
  return m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.includes('openai') || m.includes('codex')
}

export function modelTrustTier({ model, kind } = {}) {
  const m = String(model || '').toLowerCase()
  const k = String(kind || '').toLowerCase()
  if (m) {
    if (isClaudeModel(m) || isOpenAiModel(m)) return 'full'
    if (m.includes('minimax')) return 'elevated'
    // deepseek / qwen / kimi / glm and any other open or unrecognized model.
    return 'narrow'
  }
  // No model string: lean on the harness, which constrains the model set.
  // claude / codex / gpt are closed harnesses that only run trusted models;
  // goose runs arbitrary open models, so fail safe to narrow.
  if (k === 'claude' || k === 'codex' || k === 'gpt') return 'full'
  return 'narrow'
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
//   ops       — machine-level (the operator's host-work project): full-access.
//   app       — dev + tester: code, git, dev-server, browser, network, all
//               inside the worktree (cwd); the fence lease widens cwd to include
//               the dev caches so the job is never blocked.
//   math      — write across all tlda/math projects.
//   untrusted — write only its own project (cwd) + net; never across projects,
//               never machine-level. Same lane as app; the trust difference is
//               carried by the model ceiling, not the lane.
export const SPAWN_PROFILES = {
  ops: { capability: 'full-access', policy: 'unsandboxed' },
  app: { capability: 'workspace-write', policy: 'cwd' },
  math: { capability: 'workspace-write', policy: 'tlda-projects' },
  untrusted: { capability: 'workspace-write', policy: 'cwd' },
}

export const DEFAULT_SPAWN_PROFILE = 'app'

// Resolve which profile NAME a spawn into `doc` should inherit. Precedence:
// the project record's own `profile` field → config.spawnPolicy.projectProfiles
// keyed by project name → config.spawnPolicy.defaultProfile → DEFAULT_SPAWN_PROFILE.
export function resolveProjectProfileName(config = {}, { doc, project } = {}) {
  const policy = config.spawnPolicy || {}
  const fromProject = project?.profile
  const fromConfig = doc ? (policy.projectProfiles || {})[doc] : null
  const name = String(fromProject || fromConfig || policy.defaultProfile || DEFAULT_SPAWN_PROFILE).trim().toLowerCase()
  return SPAWN_PROFILES[name] ? name : DEFAULT_SPAWN_PROFILE
}

// The profile a spawn inherits, as a normalized spawn policy. This becomes the
// requested capability when the caller does not request one explicitly — the
// default fence. authorizeSpawn still bounds it by the model ceiling and the
// caller's own authority.
export function resolveProjectProfile(config = {}, { doc, project } = {}) {
  const name = resolveProjectProfileName(config, { doc, project })
  return { ...normalizeSpawnPolicy(SPAWN_PROFILES[name]), name }
}

// The operator (human, or the server owner identity) is root: never fenced, can
// confer any capability up to and including destructive full-access, and is the
// ONLY caller permitted to raise a model's trust ceiling per-agent. Every agent,
// no matter how trusted its model, resolves here as non-operator — so an agent
// can never self-escalate.
export function isOperator(caller, { serverOwnerId } = {}) {
  return !!(caller?.human || (serverOwnerId && caller?.id === serverOwnerId))
}

export function callerCapability(caller, { serverOwnerId } = {}) {
  if (isOperator(caller, { serverOwnerId })) return ROOT_CAPABILITY
  const policy = caller?.metadata?.spawnPolicy
  if (typeof policy === 'string') return normalizeCapability(policy)
  return normalizeCapability(policy?.capability, DEFAULT_AGENT_CAPABILITY)
}

export function callerSpawnPolicy(caller, { serverOwnerId } = {}) {
  if (isOperator(caller, { serverOwnerId })) return normalizeSpawnPolicy(ROOT_CAPABILITY)
  const policy = caller?.metadata?.spawnPolicy
  return normalizeSpawnPolicy(policy, DEFAULT_AGENT_CAPABILITY)
}

export function projectCapabilityToMode(capability, explicitMode = null) {
  const cap = normalizeCapability(capability)
  if (explicitMode) return explicitMode
  if (cap === 'read-only') return 'plan'
  if (cap === 'full-access') return 'auto'
  return 'default'
}

export function authorizeSpawn({ caller, requestedCapability, model, kind, trustOverride, config = {}, serverOwnerId }) {
  if (!caller?.id) throw new Error('spawn caller identity is required')
  // A per-agent trust override raises (or sets) the model ceiling for this one
  // spawn — the operator-only exception that lets a trusted minimax sit above
  // its model default. Only the operator may supply it; an agent presenting one
  // is trying to self-escalate, which is refused outright.
  if (trustOverride != null && trustOverride !== '' && !isOperator(caller, { serverOwnerId })) {
    const err = new Error('trust override is operator-only; agents cannot raise their own ceiling')
    err.code = 'SPAWN_TRUST_OVERRIDE_FORBIDDEN'
    throw err
  }
  const requestedPolicy = normalizeSpawnPolicy(requestedCapability, DEFAULT_AGENT_CAPABILITY)
  const callerPolicy = callerSpawnPolicy(caller, { serverOwnerId })
  if (!spawnPolicyLte(requestedPolicy, callerPolicy)) {
    const err = new Error(`requested spawn policy ${requestedPolicy.policy} / ${requestedPolicy.capability} exceeds caller capability/policy ${callerPolicy.policy} / ${callerPolicy.capability}`)
    err.code = 'SPAWN_CALLER_CAPABILITY'
    throw err
  }
  const ceilingPolicy = modelSpawnCeiling(config, { model, kind, trustOverride })
  if (!spawnPolicyLte(requestedPolicy, ceilingPolicy)) {
    const err = new Error(`requested spawn policy ${requestedPolicy.policy} / ${requestedPolicy.capability} exceeds model ceiling ${ceilingPolicy.policy} / ${ceilingPolicy.capability}`)
    err.code = 'SPAWN_MODEL_CEILING'
    throw err
  }
  return {
    requestedCapability: requestedPolicy.capability,
    requestedPolicy,
    callerCapability: callerPolicy.capability,
    callerPolicy,
    modelCeiling: ceilingPolicy.capability,
    modelCeilingPolicy: ceilingPolicy,
  }
}
