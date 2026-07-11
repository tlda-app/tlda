export function flattenAvailableSpawnModels(capabilities) {
  const harnesses = capabilities?.harnesses || {}
  const aliases = []
  const seen = new Set()
  const models = []

  for (const harness of Object.values(harnesses)) {
    if (!harness?.available) continue
    for (const model of harness.models || []) {
      if (!model?.alias) continue
      if (model.verified === false || model.available === false) continue
      if (seen.has(model.alias)) continue
      seen.add(model.alias)
      aliases.push(model.alias)
      models.push({
        alias: model.alias,
        kind: harness.kind || null,
        options: model.options && typeof model.options === 'object' ? model.options : {},
      })
    }
  }

  const preferredDefault = capabilities?.default?.alias || ''
  const defaultAlias = preferredDefault && seen.has(preferredDefault)
    ? preferredDefault
    : ''

  return {
    aliases,
    models,
    defaultAlias,
    machine: capabilities?.machine || null,
    generated_at: capabilities?.generated_at || null,
  }
}

export function spawnModelsFromCapabilitiesResponse(data) {
  if (!data?.ok || !data.capabilities) {
    return {
      aliases: [],
      models: [],
      defaultAlias: '',
      machine: data?.machine_id || null,
      route: data?.route || null,
      ok: false,
      error: data?.error || null,
    }
  }

  return {
    ...flattenAvailableSpawnModels(data.capabilities),
    machine: data.machine_id || data.capabilities.machine || null,
    route: data.route || null,
    ok: true,
    error: null,
  }
}
