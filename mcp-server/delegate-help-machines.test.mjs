import test from 'node:test'
import assert from 'node:assert/strict'

import { formatSpawnMachinesSummary } from './fleet-tools.mjs'

test('delegate help lists connected machines as spawn choices', () => {
  assert.equal(
    formatSpawnMachinesSummary({ machines: ['air:testing', 'mini:testing'] }),
    'Machines: air:testing, mini:testing',
  )
})

test('delegate help says none connected when the list is empty', () => {
  assert.equal(formatSpawnMachinesSummary({ machines: [] }), 'Machines: (none connected)')
})

test('delegate help distinguishes an unreachable server from an old one', () => {
  assert.equal(
    formatSpawnMachinesSummary({ unknown: 'unreachable' }),
    'Machines: (unknown — server unreachable)',
  )
  assert.equal(
    formatSpawnMachinesSummary({ unknown: 'unreported' }),
    'Machines: (connected daemons not reported by this server build)',
  )
})
