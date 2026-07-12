export function normalizeSpawnModelCatalog(catalog) {
  const models = Array.isArray(catalog?.models) ? catalog.models : []
  return models
    .map((m) => ({
      alias: String(m?.alias || '').trim(),
      id: String(m?.id || '').trim(),
      kind: String(m?.kind || '').trim().toLowerCase(),
      group: String(m?.group || m?.kind || '').trim(),
      level: typeof m?.level === 'number' ? m.level : null,
      description: typeof m?.description === 'string' ? m.description : '',
      options: m?.options && typeof m.options === 'object' ? m.options : {},
      available: m?.available !== false,
      verified: m?.verified !== false,
    }))
    .filter((m) => m.alias && m.id && m.kind)
}

export function groupSpawnModels(catalog, { verifiedOnly = false, kind = null } = {}) {
  const wantedKind = kind ? String(kind).trim().toLowerCase() : null
  const grouped = new Map()
  for (const model of normalizeSpawnModelCatalog(catalog)) {
    if (!model.available) continue
    if (verifiedOnly && !model.verified) continue
    if (wantedKind && model.kind !== wantedKind) continue
    const group = model.group || model.kind
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group).push(model)
  }
  for (const entries of grouped.values()) {
    entries.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.alias.localeCompare(b.alias))
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

  if (rawKind) {
    return {
      ok: false,
      error: 'Spawn kind is not a caller option. Choose a configured daemon model alias; the daemon model spec decides the harness.',
    }
  }

  if (!rawModel) return { ok: true }

  const matches = normalized.filter((m) => (m.alias === rawModel || m.id === rawModel) && m.available)
  if (matches.length === 0) {
    return {
      ok: false,
      error: [
        `Unknown spawn model "${model}".`,
        'Use spawn_models() to list valid aliases.',
        formatSpawnModelSummary({ models: normalized }, { verifiedOnly: true }),
      ].filter(Boolean).join('\n'),
    }
  }

  return { ok: true, model: matches[0] }
}
