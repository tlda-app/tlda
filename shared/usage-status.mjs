function pct(n) {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
}

function num(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function str(s) {
  return typeof s === 'string' && s.trim() ? s.trim() : null
}

function normalizeWindow(w = {}) {
  const used = num(w.used)
  const limit = num(w.limit)
  const remaining = num(w.remaining)
  const remainingPct = pct(
    w.remainingPct ?? (
      remaining !== null && limit && limit > 0 ? (remaining / limit) * 100
        : used !== null && limit && limit > 0 ? ((limit - used) / limit) * 100
          : null
    ),
  )
  return {
    label: str(w.label) || 'window',
    resetsAt: str(w.resetsAt),
    used,
    limit,
    remaining,
    remainingPct,
  }
}

function normalizeSpend(spend = null) {
  if (!spend || typeof spend !== 'object') return null
  return {
    currency: str(spend.currency) || 'USD',
    used: num(spend.used),
    limit: num(spend.limit),
    remaining: num(spend.remaining),
  }
}

export function normalizeUsageStatus(config = {}) {
  const raw = config.usageStatus || {}
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : []
  return {
    asOf: str(raw.asOf) || null,
    accounts: accounts.map((a, i) => ({
      id: str(a.id) || `account-${i + 1}`,
      provider: str(a.provider) || 'unknown',
      label: str(a.label) || str(a.id) || `Account ${i + 1}`,
      source: str(a.source) || 'manual',
      asOf: str(a.asOf) || str(raw.asOf) || null,
      confidence: str(a.confidence) || 'manual',
      windows: Array.isArray(a.windows) ? a.windows.map(normalizeWindow) : [],
      spend: normalizeSpend(a.spend),
      notes: str(a.notes),
    })),
  }
}

export function formatUsageStatus(status) {
  if (!status.accounts.length) {
    return [
      'No usage status is configured.',
      '',
      'Add manual/static account status under `usageStatus.accounts` in the tlda config. Provider UI scraping is intentionally not used.',
    ].join('\n')
  }

  const lines = ['Usage status:']
  for (const account of status.accounts) {
    const head = [`- ${account.label}`, `provider=${account.provider}`, `source=${account.source}`, `confidence=${account.confidence}`]
    if (account.asOf) head.push(`asOf=${account.asOf}`)
    lines.push(head.join(' · '))
    for (const w of account.windows) {
      const parts = [`  - ${w.label}`]
      if (w.remainingPct !== null) parts.push(`${w.remainingPct.toFixed(0)}% remaining`)
      if (w.used !== null && w.limit !== null) parts.push(`${w.used}/${w.limit} used`)
      else if (w.remaining !== null && w.limit !== null) parts.push(`${w.remaining}/${w.limit} remaining`)
      if (w.resetsAt) parts.push(`resets ${w.resetsAt}`)
      lines.push(parts.join(' · '))
    }
    if (account.spend) {
      const s = account.spend
      const parts = ['  - spend']
      if (s.used !== null && s.limit !== null) parts.push(`${s.used}/${s.limit} ${s.currency}`)
      else if (s.remaining !== null) parts.push(`${s.remaining} ${s.currency} remaining`)
      lines.push(parts.join(' · '))
    }
    if (account.notes) lines.push(`  - note: ${account.notes}`)
  }
  return lines.join('\n')
}
