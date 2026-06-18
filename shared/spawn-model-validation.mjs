export function normalizeSpawnModelCatalog(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  return models
    .map((m) => ({
      alias: String(m?.alias || '').trim(),
      id: String(m?.id || '').trim(),
      kind: String(m?.kind || '').trim().toLowerCase(),
      verified: m?.verified !== false,
    }))
    .filter((m) => m.alias && m.id && m.kind)
}

export function groupSpawnModels(catalog, { verifiedOnly = false, kind = null } = {}) {
  const wantedKind = kind ? String(kind).trim().toLowerCase() : null
  const grouped = new Map()
  for (const model of normalizeSpawnModelCatalog(catalog)) {
    if (verifiedOnly && !model.verified) continue
    if (wantedKind && model.kind !== wantedKind) continue
    if (!grouped.has(model.kind)) grouped.set(model.kind, [])
    grouped.get(model.kind).push(model)
  }
  for (const entries of grouped.values()) {
    entries.sort((a, b) => a.alias.localeCompare(b.alias))
  }
  return grouped
}

export function formatSpawnModelSummary(catalog, { verifiedOnly = false, kind = null } = {}) {
  const grouped = groupSpawnModels(catalog, { verifiedOnly, kind })
  if (grouped.size === 0) return 'No spawn models found.'
  const lines = []
  for (const [groupKind, entries] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const aliases = entries.map((m) => {
      const suffix = m.verified ? '' : ' (unverified)'
      return m.alias === m.id ? `${m.alias}${suffix}` : `${m.alias} -> ${m.id}${suffix}`
    })
    lines.push(`${groupKind}: ${aliases.join(', ')}`)
  }
  return lines.join('\n')
}

export function findSpawnModel(catalog, model) {
  const raw = String(model || '').trim()
  if (!raw) return null
  return normalizeSpawnModelCatalog(catalog).filter((m) => m.alias === raw || m.id === raw)
}

export function validateSpawnModelSelection({ model, kind } = {}, catalog) {
  const rawModel = String(model || '').trim()
  const rawKind = String(kind || '').trim().toLowerCase()
  const normalized = normalizeSpawnModelCatalog(catalog)

  if (rawKind && !normalized.some((m) => m.kind === rawKind)) {
    const kinds = [...new Set(normalized.map((m) => m.kind))].sort()
    return {
      ok: false,
      error: `Unknown spawn kind "${kind}". Valid kinds: ${kinds.join(', ')}.`,
    }
  }

  if (!rawModel) return { ok: true }

  const matches = normalized.filter((m) => m.alias === rawModel || m.id === rawModel)
  if (matches.length === 0) {
    if (rawModel.includes('/')) {
      if (!rawKind || rawKind === 'goose') {
        return { ok: true, model: { alias: rawModel, id: rawModel, kind: 'goose', verified: false, raw: true } }
      }
      return {
        ok: false,
        error: [
          `Raw vendor/model id "${model}" can only run through kind "goose"; kind "${kind}" was requested.`,
          formatSpawnModelSummary({ models: normalized }, { verifiedOnly: true, kind: rawKind }),
        ].filter(Boolean).join('\n'),
      }
    }
    return {
      ok: false,
      error: [
        `Unknown spawn model "${model}".`,
        'Use spawn_models() to list valid aliases.',
        formatSpawnModelSummary({ models: normalized }, { verifiedOnly: true }),
      ].filter(Boolean).join('\n'),
    }
  }

  if (rawKind && !matches.some((m) => m.kind === rawKind)) {
    const actual = [...new Set(matches.map((m) => m.kind))].sort().join(', ')
    return {
      ok: false,
      error: [
        `Spawn model "${model}" belongs to ${actual}, but kind "${kind}" was requested.`,
        `Use kind "${matches[0].kind}" with model "${matches[0].alias}", or choose a ${rawKind} model from spawn_models().`,
        formatSpawnModelSummary({ models: normalized }, { verifiedOnly: true, kind: rawKind }),
      ].filter(Boolean).join('\n'),
    }
  }

  return { ok: true, model: matches[0] }
}
