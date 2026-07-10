export const DEFAULT_MODEL = 'claude-opus-4-8[1m]'

export const MODEL_ALIASES = Object.freeze({
  fable: 'claude-fable-5',
  fable5: 'claude-fable-5',
  opus: DEFAULT_MODEL,
  opus45: 'claude-opus-4-5',
  opus46: 'claude-opus-4-6[1m]',
  opus47: 'claude-opus-4-7[1m]',
  opus48: 'claude-opus-4-8[1m]',
  sonnet: 'claude-sonnet-5',
  sonnet5: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
})

export const GOOSE_MODELS = Object.freeze({
  cursor: 'cursor-agent/default',
  'cursor-agent': 'cursor-agent/default',
  'cursor-default': 'cursor-agent/default',
  deepseek: 'deepseek/deepseek-v4-pro',
  'deepseek-chat': 'deepseek/deepseek-chat',
  'deepseek-v3': 'deepseek/deepseek-v3.2',
  'deepseek-r1': 'deepseek/deepseek-r1-0528',
  'deepseek-reasoner': 'deepseek/deepseek-r1-0528',
  'deepseek-v4': 'deepseek/deepseek-v4-pro',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash',
  kimi: 'moonshotai/kimi-k2.7-code',
  'kimi-k2.7': 'moonshotai/kimi-k2.7-code',
  qwen: 'qwen/qwen3.7-max',
  'qwen3.7-max': 'qwen/qwen3.7-max',
  glm: 'z-ai/glm-5.1',
  'glm-5.1': 'z-ai/glm-5.1',
  minimax: 'minimax/minimax-m3',
  'minimax-m3': 'minimax/minimax-m3',
  gemini: 'google/gemini-3.5-flash',
  'gemini-3.5-flash': 'google/gemini-3.5-flash',
  mistral: 'mistralai/mistral-medium-3-5',
  'mistral-medium-3-5': 'mistralai/mistral-medium-3-5',
})

export const GOOSE_VERIFIED = new Set([
  'cursor-agent/default',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-r1-0528',
  'moonshotai/kimi-k2.7-code',
  'qwen/qwen3.7-max',
  'z-ai/glm-5.1',
  'minimax/minimax-m3',
  'mistralai/mistral-medium-3-5',
])

export const CODEX_MODELS = Object.freeze({
  gpt: 'gpt-5.5',
  gpt55: 'gpt-5.5',
  codex: 'gpt-5.5',
})

const ACCOUNT_PROVIDERS = new Set(['claude', 'codex'])
const PROVIDER_KIND = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  openrouter: 'goose',
  deepseek: 'goose',
  'cursor-agent': 'goose',
})
const DEFAULT_ALIAS = Object.freeze({
  claude: 'opus',
  codex: 'gpt',
  goose: 'deepseek',
})

function tags(...values) {
  return values.filter(Boolean)
}

function providerTags(provider, id) {
  if (provider === 'claude') return tags('claude', 'provider:claude', 'cloud', id?.includes('opus') && 'opus', id?.includes('sonnet') && 'sonnet', id?.includes('haiku') && 'haiku')
  if (provider === 'codex') return tags('codex', 'gpt', 'provider:codex', 'cloud')
  if (provider === 'deepseek') return tags('deepseek', 'provider:deepseek', 'cloud')
  if (provider === 'cursor-agent') return tags('cursor', 'provider:cursor-agent', 'local')
  const family = String(id || '').split('/', 1)[0]
  return tags(family, family?.startsWith('deepseek') && 'deepseek', `provider:${provider}`, 'cloud')
}

export const BUILTIN_MODEL_TABLE = Object.freeze({
  claude: Object.freeze(Object.fromEntries(Object.entries(MODEL_ALIASES).map(([alias, id]) => [alias, Object.freeze({ id, tags: Object.freeze(providerTags('claude', id)) })]))),
  codex: Object.freeze(Object.fromEntries(Object.entries(CODEX_MODELS).map(([alias, id]) => [alias, Object.freeze({ id, tags: Object.freeze(providerTags('codex', id)) })]))),
  openrouter: Object.freeze(Object.fromEntries(Object.entries(GOOSE_MODELS)
    .filter(([, id]) => !id.startsWith('cursor-agent/'))
    .map(([alias, id]) => [alias, Object.freeze({ id, tags: Object.freeze(providerTags('openrouter', id)) })]))),
  'cursor-agent': Object.freeze(Object.fromEntries(Object.entries(GOOSE_MODELS)
    .filter(([, id]) => id.startsWith('cursor-agent/'))
    .map(([alias, id]) => [alias, Object.freeze({ id, tags: Object.freeze(providerTags('cursor-agent', id)) })]))),
})

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase()
}

function normalizeModelConfigEntry(provider, alias, value, { configured = false } = {}) {
  if (value == null) return null
  const entry = typeof value === 'string' ? { id: value } : value
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const id = entry.id == null || entry.id === '' ? null : String(entry.id)
  const providerAlias = entry.provider_alias == null || entry.provider_alias === '' ? null : String(entry.provider_alias)
  const entryTags = Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag).trim()).filter(Boolean) : providerTags(provider, id || providerAlias || alias)
  return {
    alias: String(alias),
    provider,
    provider_alias: providerAlias,
    id,
    tags: entryTags,
    configured,
  }
}

function configuredEntries(config = {}) {
  const out = []
  const models = config?.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) return out
  for (const [providerName, aliases] of Object.entries(models)) {
    const provider = normalizeProvider(providerName)
    if (!provider || !aliases || typeof aliases !== 'object' || Array.isArray(aliases)) continue
    for (const [alias, value] of Object.entries(aliases)) {
      const entry = normalizeModelConfigEntry(provider, alias, value, { configured: true })
      if (entry) out.push(entry)
    }
  }
  return out
}

function builtinEntries() {
  const out = []
  for (const [provider, aliases] of Object.entries(BUILTIN_MODEL_TABLE)) {
    for (const [alias, value] of Object.entries(aliases)) {
      const entry = normalizeModelConfigEntry(provider, alias, value)
      if (entry) out.push(entry)
    }
  }
  return out
}

function entriesForKind(kind, config = {}) {
  const seenAliases = new Set()
  const out = []
  for (const entry of [...configuredEntries(config), ...builtinEntries()]) {
    if (PROVIDER_KIND[entry.provider] !== kind) continue
    if (seenAliases.has(entry.alias)) continue
    seenAliases.add(entry.alias)
    out.push(entry)
  }
  return out
}

function tagDecision(config, tag) {
  const raw = config?.tags && typeof config.tags === 'object' ? config.tags[tag] : null
  return String(raw || 'allow').trim().toLowerCase()
}

function assertTagsAllowed(entry, config = {}) {
  const denied = (entry.tags || []).filter((tag) => tagDecision(config, tag) === 'none')
  if (!denied.length) return
  const err = new Error(`Model "${entry.alias}" refused by model tag gate: ${denied.join(', ')}`)
  err.code = 'MODEL_TAG_REFUSED'
  err.tags = denied
  throw err
}

function accountProviderForKind(kind) {
  if (kind === 'claude') return 'claude'
  if (kind === 'codex') return 'codex'
  return null
}

function selectionFromEntry(entry, config = {}) {
  assertTagsAllowed(entry, config)
  if (entry.id) return { model: entry.id, provider: entry.provider, alias: entry.alias, tags: entry.tags, table: entry.configured ? 'config' : 'builtin' }
  if (ACCOUNT_PROVIDERS.has(entry.provider)) return { model: entry.provider_alias || entry.alias, provider: entry.provider, alias: entry.alias, tags: entry.tags, table: entry.configured ? 'config' : 'builtin' }
  const err = new Error(`Model alias "${entry.alias}" for provider "${entry.provider}" requires an id`)
  err.code = 'MODEL_ID_REQUIRED'
  throw err
}

function resolveModelSelection(kind, model, config = {}) {
  const raw = String(model || '').trim()
  const requested = raw || DEFAULT_ALIAS[kind] || ''
  const explicit = entriesForKind(kind, config).find((entry) => entry.alias === requested)
  if (explicit) return selectionFromEntry(explicit, config)

  const accountProvider = accountProviderForKind(kind)
  if (accountProvider) {
    const id = requested
    assertTagsAllowed({ alias: requested, provider: accountProvider, tags: providerTags(accountProvider, id) }, config)
    if (kind === 'claude') {
      if (id.startsWith('claude-')) return { model: id, provider: accountProvider, alias: requested, tags: providerTags(accountProvider, id), table: 'passthrough' }
      return { model: id, provider: accountProvider, alias: requested, tags: providerTags(accountProvider, id), table: 'account' }
    }
    if (/^gpt/i.test(id)) return { model: id, provider: accountProvider, alias: requested, tags: providerTags(accountProvider, id), table: 'passthrough' }
    return { model: id, provider: accountProvider, alias: requested, tags: providerTags(accountProvider, id), table: 'account' }
  }

  if (requested.includes('/')) {
    const provider = requested.startsWith('cursor-agent/') ? 'cursor-agent' : 'openrouter'
    assertTagsAllowed({ alias: requested, provider, tags: providerTags(provider, requested) }, config)
    return { model: requested, provider, alias: requested, tags: providerTags(provider, requested), table: 'passthrough' }
  }

  throw new Error(`Unknown goose model: ${JSON.stringify(model)}. Valid: ${entriesForKind('goose', config).map((entry) => entry.alias).sort().join(', ')} or vendor/model`)
}

export function resolveClaudeModelSelection(model, { config = {} } = {}) {
  return resolveModelSelection('claude', model, config)
}

export function resolveGooseModelSelection(model, { config = {} } = {}) {
  return resolveModelSelection('goose', model, config)
}

export function resolveCodexModelSelection(model, { config = {} } = {}) {
  return resolveModelSelection('codex', model, config)
}

export function resolveClaudeModel(model, options = {}) {
  return resolveClaudeModelSelection(model, options).model
}

export function resolveGooseModel(model, options = {}) {
  return resolveGooseModelSelection(model, options).model
}

export function gooseModelVerified(model) {
  return GOOSE_VERIFIED.has(model)
}

export function resolveCodexModel(model, options = {}) {
  return resolveCodexModelSelection(model, options).model
}

export function inferHarnessKind(kind, model) {
  if (kind) return kind
  const raw = String(model || '')
  if (raw in CODEX_MODELS || raw.startsWith('gpt') || raw === 'codex') return 'codex'
  if (raw in GOOSE_MODELS || raw.includes('/')) return 'goose'
  return 'claude'
}

export function listModels(config = {}) {
  const models = entriesForKind('claude', config).concat(entriesForKind('goose', config), entriesForKind('codex', config))
    .map((entry) => {
      let selection = null
      let available = true
      try {
        selection = selectionFromEntry(entry, config)
      } catch {
        available = false
      }
      return {
        alias: entry.alias,
        id: selection?.model || entry.id || entry.provider_alias || entry.alias,
        verified: entry.provider !== 'openrouter' || GOOSE_VERIFIED.has(selection?.model || entry.id),
        available,
        kind: PROVIDER_KIND[entry.provider],
        provider: entry.provider,
        tags: entry.tags,
      }
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.alias.localeCompare(b.alias))
  return {
    default: GOOSE_MODELS.deepseek,
    models,
    verified: [...GOOSE_VERIFIED].sort(),
  }
}
