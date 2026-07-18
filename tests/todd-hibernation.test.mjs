import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dueHibernations,
  formatDuration,
  normalizedPolicies,
  parseHibernationCommand,
} from '../bots/todd/hibernation.mjs'

test('parses direct and addressed per-agent configuration', () => {
  assert.deepEqual(parseHibernationCommand('Todd, hibernate mango after 20 minutes'), {
    action: 'enable', target: 'mango', idleSeconds: 1200,
  })
  assert.deepEqual(parseHibernationCommand('hibernation off for mango', { direct: true }), {
    action: 'disable', target: 'mango',
  })
  assert.deepEqual(parseHibernationCommand('Todd show hibernation'), { action: 'show' })
  assert.equal(parseHibernationCommand('we discussed Todd hibernation'), null)
})

test('absence is disabled and malformed policies are discarded', () => {
  assert.deepEqual(normalizedPolicies(null), {})
  assert.deepEqual(normalizedPolicies({
    'fleet:good': { enabled: true, idleSeconds: 1200 },
    'fleet:disabled': { enabled: false, idleSeconds: 60 },
    bad: { enabled: true, idleSeconds: 1 },
    'fleet:nope': { enabled: true, idleSeconds: 0 },
  }), {
    'fleet:good': { enabled: true, idleSeconds: 1200 },
    'fleet:disabled': { enabled: false, idleSeconds: 60 },
  })
})

test('only trusted idle facts crossing enabled thresholds are due', () => {
  const policies = {
    'fleet:due': { enabled: true, idleSeconds: 60 },
    'fleet:not-yet': { enabled: true, idleSeconds: 61 },
    'fleet:off': { enabled: false, idleSeconds: 1 },
    'fleet:busy': { enabled: true, idleSeconds: 1 },
  }
  assert.deepEqual(dueHibernations(policies, {
    'fleet:due': 60,
    'fleet:not-yet': 60,
    'fleet:off': 500,
    'fleet:busy': 500,
  }, new Set(['fleet:busy'])), [{ agentId: 'fleet:due', idleSeconds: 60, thresholdSeconds: 60 }])
})

test('formats thresholds for human-facing chat', () => {
  assert.equal(formatDuration(1), '1 second')
  assert.equal(formatDuration(120), '2 minutes')
  assert.equal(formatDuration(7200), '2 hours')
})
