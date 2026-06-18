export const SPAWN_CAPABILITIES = [
  'read-only',
  'workspace-write-no-net',
  'workspace-write+net',
  'full-access',
]

export const SPAWN_POLICY_OPTIONS = {
  read: { capability: 'read-only', policy: 'cwd', category: 'write-scope' },
  write: { capability: 'workspace-write+net', policy: 'cwd', category: 'write-scope' },
  'tlda-write': { capability: 'workspace-write+net', policy: 'tlda-projects', category: 'write-scope' },
  full: { capability: 'full-access', policy: 'unsandboxed', category: 'write-scope' },
}

const CAPABILITY_RANK = new Map(SPAWN_CAPABILITIES.map((cap, idx) => [cap, idx]))
const POLICY_RANK = new Map([
  ['cwd', 0],
  ['tlda-projects', 1],
  ['unsandboxed', 2],
])

export const DEFAULT_AGENT_CAPABILITY = 'workspace-write+net'
export const ROOT_CAPABILITY = 'full-access'

const CAPABILITY_DEFAULT_POLICY = {
  'read-only': 'cwd',
  'workspace-write-no-net': 'cwd',
  'workspace-write+net': 'cwd',
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
  const cap = resolveSpawnPolicyOption(raw)?.capability || raw
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

export function defaultModelCeiling({ model, kind } = {}) {
  const family = modelFamily({ model, kind })
  if (family === 'claude' || family === 'gpt' || family === 'codex') return ROOT_CAPABILITY
  return DEFAULT_AGENT_CAPABILITY
}

export function modelCeiling(config = {}, { model, kind } = {}) {
  return modelSpawnCeiling(config, { model, kind }).capability
}

export function modelSpawnCeiling(config = {}, { model, kind } = {}) {
  const family = modelFamily({ model, kind })
  const policy = config.spawnPolicy || {}
  const byModel = policy.modelCeilings || {}
  const byFamily = policy.familyCeilings || {}
  const configured = (model && byModel[model]) || byFamily[family] || policy.defaultCeiling
  return normalizeSpawnPolicy(configured, defaultModelCeiling({ model, kind }))
}

export function callerCapability(caller, { serverOwnerId } = {}) {
  if (caller?.human || (serverOwnerId && caller?.id === serverOwnerId)) return ROOT_CAPABILITY
  const policy = caller?.metadata?.spawnPolicy
  if (typeof policy === 'string') return normalizeCapability(policy)
  return normalizeCapability(policy?.capability, DEFAULT_AGENT_CAPABILITY)
}

export function callerSpawnPolicy(caller, { serverOwnerId } = {}) {
  if (caller?.human || (serverOwnerId && caller?.id === serverOwnerId)) return normalizeSpawnPolicy(ROOT_CAPABILITY)
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

export function authorizeSpawn({ caller, requestedCapability, model, kind, config = {}, serverOwnerId }) {
  if (!caller?.id) throw new Error('spawn caller identity is required')
  const requestedPolicy = normalizeSpawnPolicy(requestedCapability, DEFAULT_AGENT_CAPABILITY)
  const callerPolicy = callerSpawnPolicy(caller, { serverOwnerId })
  if (!spawnPolicyLte(requestedPolicy, callerPolicy)) {
    const err = new Error(`requested spawn policy ${requestedPolicy.policy} / ${requestedPolicy.capability} exceeds caller capability/policy ${callerPolicy.policy} / ${callerPolicy.capability}`)
    err.code = 'SPAWN_CALLER_CAPABILITY'
    throw err
  }
  const ceilingPolicy = modelSpawnCeiling(config, { model, kind })
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
