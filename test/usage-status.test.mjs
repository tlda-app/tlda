import assert from 'node:assert/strict'
import test from 'node:test'

import { formatUsageStatus, normalizeUsageStatus } from '../shared/usage-status.mjs'

test('normalizeUsageStatus sanitizes configured account status', () => {
  const status = normalizeUsageStatus({
    usageStatus: {
      asOf: '2026-06-17T22:00:00Z',
      accounts: [{
        id: 'claude-main',
        provider: 'anthropic',
        label: 'Claude main',
        source: 'manual',
        authRef: 'do-not-expose',
        windows: [
          { label: '5h', used: 30, limit: 100, resetsAt: '2026-06-18T01:00:00Z' },
          { label: 'weekly', remaining: 12, limit: 40 },
          { label: 'bad', remainingPct: 140 },
        ],
      }],
    },
  })

  assert.deepEqual(status.accounts[0], {
    id: 'claude-main',
    provider: 'anthropic',
    label: 'Claude main',
    source: 'manual',
    asOf: '2026-06-17T22:00:00Z',
    confidence: 'manual',
    windows: [
      { label: '5h', resetsAt: '2026-06-18T01:00:00Z', used: 30, limit: 100, remaining: null, remainingPct: 70 },
      { label: 'weekly', resetsAt: null, used: null, limit: 40, remaining: 12, remainingPct: 30 },
      { label: 'bad', resetsAt: null, used: null, limit: null, remaining: null, remainingPct: 100 },
    ],
    spend: null,
    notes: null,
  })
  assert.equal('authRef' in status.accounts[0], false)
})

test('formatUsageStatus reports missing config without provider scraping', () => {
  assert.match(formatUsageStatus(normalizeUsageStatus({})), /No usage status is configured/)
  assert.match(formatUsageStatus(normalizeUsageStatus({})), /Provider UI scraping is intentionally not used/)
})

test('formatUsageStatus renders windows and spend summaries', () => {
  const text = formatUsageStatus(normalizeUsageStatus({
    usageStatus: {
      accounts: [{
        id: 'openrouter',
        provider: 'openrouter',
        source: 'manual',
        confidence: 'stale',
        windows: [{ label: 'monthly', remainingPct: 55 }],
        spend: { used: 4.25, limit: 20, currency: 'USD' },
        notes: 'updated by hand',
      }],
    },
  }))
  assert.match(text, /provider=openrouter/)
  assert.match(text, /55% remaining/)
  assert.match(text, /4.25\/20 USD/)
  assert.match(text, /updated by hand/)
})
