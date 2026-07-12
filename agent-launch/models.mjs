function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null
  const alias = String(spec.alias || '').trim()
  const id = String(spec.id || spec.model || '').trim()
  const harness = String(spec.harness || '').trim().toLowerCase()
  if (!alias || !id || !harness) return null
  return {
    ...spec,
    alias,
    id,
    model: id,
    harness,
    kind: harness,
    provider: spec.provider ? String(spec.provider).trim().toLowerCase() : harness,
    group: spec.group ? String(spec.group).trim() : (spec.provider ? String(spec.provider).trim().toLowerCase() : harness),
    level: Number.isFinite(Number(spec.level)) ? Number(spec.level) : null,
    description: typeof spec.description === 'string' ? spec.description : '',
    options: normalizeModelOptions(spec.options),
    tags: Array.isArray(spec.tags) ? spec.tags.map(tag => String(tag).trim()).filter(Boolean) : [],
    available: spec.available !== false,
    verified: spec.verified !== false,
  }
}

function normalizeModelOptions(options = {}) {
  const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  const out = {}
  for (const [name, spec] of Object.entries(source)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) continue
    const values = spec.values && typeof spec.values === 'object' && !Array.isArray(spec.values)
      ? spec.values
      : {}
    out[name] = {
      default: spec.default == null ? '' : String(spec.default),
      values: Object.fromEntries(Object.entries(values).map(([value, valueSpec]) => [
        String(value),
        valueSpec && typeof valueSpec === 'object' && !Array.isArray(valueSpec)
          ? {
              ...(valueSpec.description ? { description: String(valueSpec.description) } : {}),
              ...(valueSpec.options ? { options: normalizeModelOptions(valueSpec.options) } : {}),
            }
          : {},
      ])),
    }
  }
  return out
}

function modelSpecs(config = {}) {
  const source = config?.modelSpecs && typeof config.modelSpecs === 'object' && !Array.isArray(config.modelSpecs)
    ? config.modelSpecs
    : {}
  return Object.values(source).map(normalizeSpec).filter(Boolean)
}

function defaultModelAlias(config = {}) {
  return typeof config?.modelCatalog?.default === 'string' && config.modelCatalog.default.trim()
    ? config.modelCatalog.default.trim()
    : ''
}

export function resolveModelSpec(model, { config = {} } = {}) {
  const requested = String(model || '').trim() || defaultModelAlias(config)
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

export function normalizeSpawnModelKwargs(kwargs = {}, { config = {}, allowDefaultModel = true } = {}) {
  const source = kwargs && typeof kwargs === 'object' && !Array.isArray(kwargs) ? kwargs : {}
  const model = String(source.model || '').trim() || (allowDefaultModel ? defaultModelAlias(config) : '')
  const spec = resolveModelSpec(model, { config })
  const options = {}
  const activeOptionSpecs = {}
  const knownKeys = new Set(['model'])

  function visit(optionSpecs = {}) {
    for (const [name, optionSpec] of Object.entries(optionSpecs || {})) {
      knownKeys.add(name)
      activeOptionSpecs[name] = optionSpec
      const hasValue = Object.prototype.hasOwnProperty.call(source, name)
      const value = hasValue ? String(source[name]) : String(optionSpec.default || '')
      if (!value) throw new Error(`missing required model option "${name}" for "${spec.alias}"`)
      if (!Object.prototype.hasOwnProperty.call(optionSpec.values || {}, value)) {
        const values = Object.keys(optionSpec.values || {}).join(', ')
        throw new Error(`invalid model option ${name}="${value}" for "${spec.alias}"${values ? `; allowed: ${values}` : ''}`)
      }
      options[name] = value
      const selected = optionSpec.values?.[value]
      if (selected?.options) visit(selected.options)
    }
  }
  visit(spec.options || {})
  const unknown = Object.keys(source).filter(key => !knownKeys.has(key) && source[key] != null && source[key] !== '')
  if (unknown.length) throw new Error(`unknown model option(s) for "${spec.alias}": ${unknown.join(', ')}`)
  return {
    model: spec.alias,
    alias: spec.alias,
    id: spec.id,
    harness: spec.harness,
    provider: spec.provider,
    group: spec.group,
    level: spec.level,
    description: spec.description,
    options,
    activeOptionSpecs,
    spec,
  }
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

export function gooseModelVerified(model, options = {}) {
  return resolveGooseModelSelection(model, options).spec.verified !== false
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
      group: spec.group,
      level: spec.level,
      description: spec.description,
      tags: spec.tags,
      options: spec.options || {},
      harnessOptions: spec.harnessOptions || {},
    }))
    .sort((a, b) => String(a.group || '').localeCompare(String(b.group || '')) || (a.level ?? 0) - (b.level ?? 0) || a.alias.localeCompare(b.alias))
  return {
    defaultAlias: defaultModelAlias(config),
    models,
  }
}
