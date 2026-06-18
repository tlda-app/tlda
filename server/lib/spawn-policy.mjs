export const SPAWN_CAPABILITIES = [
  'read-only',
  'workspace-write-no-net',
  'workspace-write+net',
  'full-access',
]

export const CAPABILITY_ALIASES = {
  read: 'read-only',
  readonly: 'read-only',
  'read-only': 'read-only',
  write: 'workspace-write+net',
  'workspace-write': 'workspace-write+net',
  net: 'workspace-write+net',
  'write-net': 'workspace-write+net',
  'workspace-write+net': 'workspace-write+net',
  offline: 'workspace-write-no-net',
  'no-net': 'workspace-write-no-net',
  'workspace-write-no-net': 'workspace-write-no-net',
  full: 'full-access',
  root: 'full-access',
  unfenced: 'full-access',
  'full-access': 'full-access',
}

const CAPABILITY_RANK = new Map(SPAWN_CAPABILITIES.map((cap, idx) => [cap, idx]))
export const DEFAULT_AGENT_CAPABILITY = 'workspace-write+net'
export const ROOT_CAPABILITY = 'full-access'

export function normalizeCapability(value, fallback = null) {
  if (value == null || value === '') {
    if (fallback == null) return null
    return normalizeCapability(fallback)
  }
  const raw = String(value).trim().toLowerCase()
  const cap = CAPABILITY_ALIASES[raw] || raw
  if (!CAPABILITY_RANK.has(cap)) {
    throw new Error(`unknown spawn capability "${value}"`)
  }
  return cap
}

export function capabilityLte(left, right) {
  const a = normalizeCapability(left)
  const b = normalizeCapability(right)
  return CAPABILITY_RANK.get(a) <= CAPABILITY_RANK.get(b)
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
  const family = modelFamily({ model, kind })
  const policy = config.spawnPolicy || {}
  const byModel = policy.modelCeilings || {}
  const byFamily = policy.familyCeilings || {}
  const configured = (model && byModel[model]) || byFamily[family] || policy.defaultCeiling
  return normalizeCapability(configured, defaultModelCeiling({ model, kind }))
}

export function callerCapability(caller, { serverOwnerId } = {}) {
  if (caller?.human || (serverOwnerId && caller?.id === serverOwnerId)) return ROOT_CAPABILITY
  const policy = caller?.metadata?.spawnPolicy
  if (typeof policy === 'string') return normalizeCapability(policy)
  return normalizeCapability(policy?.capability, DEFAULT_AGENT_CAPABILITY)
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
  const requested = normalizeCapability(requestedCapability, DEFAULT_AGENT_CAPABILITY)
  const callerCap = callerCapability(caller, { serverOwnerId })
  if (!capabilityLte(requested, callerCap)) {
    const err = new Error(`requested capability ${requested} exceeds caller capability ${callerCap}`)
    err.code = 'SPAWN_CALLER_CAPABILITY'
    throw err
  }
  const ceiling = modelCeiling(config, { model, kind })
  if (!capabilityLte(requested, ceiling)) {
    const err = new Error(`requested capability ${requested} exceeds model ceiling ${ceiling}`)
    err.code = 'SPAWN_MODEL_CEILING'
    throw err
  }
  return { requestedCapability: requested, callerCapability: callerCap, modelCeiling: ceiling }
}
