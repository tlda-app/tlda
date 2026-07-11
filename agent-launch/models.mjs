const PROVIDER_HARNESS = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  openrouter: 'goose',
  deepseek: 'goose',
  'cursor-agent': 'goose',
  goose: 'goose',
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

export const GOOSE_MODELS = Object.freeze({})

function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  const alias = String(spec.alias || '').trim()
  const id = String(spec.id || spec.model || '').trim()
  const harness = String(spec.harness || PROVIDER_HARNESS[String(spec.provider || '').trim().toLowerCase()] || '').trim().toLowerCase()
  if (!alias || !id || !harness) return null
  return {
    ...spec,
    alias,
    id,
    model: id,
    harness,
    kind: harness,
    provider: spec.provider ? String(spec.provider).trim().toLowerCase() : harness,
    tags: Array.isArray(spec.tags) ? spec.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
    available: spec.available !== false,
    verified: spec.verified !== false,
  }
}

function modelSpecs(config = {}) {
  const source = config?.modelSpecs && typeof config.modelSpecs === 'object' && !Array.isArray(config.modelSpecs)
    ? config.modelSpecs
    : {}
  return Object.values(source).map(normalizeSpec).filter(Boolean)
}

export function resolveModelSpec(model, { config = {} } = {}) {
  const requested = String(model || '').trim()
  if (!requested) {
    throw new Error('spawn model is required: configure and request a daemon model alias; no code default is allowed')
  }
  const matches = modelSpecs(config).filter(spec => spec.alias === requested || spec.id === requested)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`ambiguous daemon model "${requested}": ${matches.map(spec => `${spec.alias}:${spec.harness}`).join(', ')}`)
  }
  const known = modelSpecs(config).map(spec => spec.alias).sort().join(', ')
  throw new Error(`unknown daemon model "${requested}"${known ? `; configured aliases: ${known}` : '; no daemon models are configured'}`)
}

function resolveHarnessModel(harness, model, options = {}) {
  const spec = resolveModelSpec(model, options)
  if (spec.harness !== harness) {
    throw new Error(`daemon model "${model}" is configured for harness "${spec.harness}", not "${harness}"`)
  }
  return {
    model: spec.id,
    provider: spec.provider,
    alias: spec.alias,
    tags: spec.tags,
    table: 'daemon',
    spec,
  }
}

export function resolveClaudeModelSelection(model, options = {}) {
  return resolveHarnessModel('claude', model, options)
}

export function resolveGooseModelSelection(model, options = {}) {
  return resolveHarnessModel('goose', model, options)
}

export function resolveCodexModelSelection(model, options = {}) {
  return resolveHarnessModel('codex', model, options)
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

export function listModels(config = {}) {
  const models = modelSpecs(config)
    .map(spec => ({
      alias: spec.alias,
      id: spec.id,
      verified: spec.verified,
      available: spec.available,
      kind: spec.harness,
      harness: spec.harness,
      provider: spec.provider,
      tags: spec.tags,
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.alias.localeCompare(b.alias))
  return {
    models,
    verified: [...GOOSE_VERIFIED].sort(),
  }
}
