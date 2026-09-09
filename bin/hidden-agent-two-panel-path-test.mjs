#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { fleetAgentListed, getFleetAgentDirectoryRows } from '../src/shapes/FleetAgentDirectoryModel.ts'

const root = new URL('../', import.meta.url)
const agentsPanel = readFileSync(new URL('src/shapes/FleetAgentsShape.tsx', root), 'utf8')
const filterPage = readFileSync(new URL('src/shapes/FleetChatShape.tsx', root), 'utf8')
const directoryModel = readFileSync(new URL('src/shapes/FleetAgentDirectoryModel.ts', root), 'utf8')

test('the big Agents panel and chat Filter page consume the same visibility selector', () => {
  assert.match(agentsPanel, /if \(!fleetAgentListed\(a\)\) continue/)
  assert.match(filterPage, /getFleetAgentDirectoryRows\(choiceAgents\)/)
  assert.match(directoryModel, /filter\(fleetAgentListed\)/)
})

test('the shared selector hides metadata-hidden rows on both paths without a name rule', () => {
  const rows = [
    { id: 'fleet:ordinary', dead: false, metadata: {} },
    { id: 'fleet:probe', dead: false, labels: ['dev-probe'], metadata: { hidden: true } },
    { id: 'fleet:label-only', dead: false, labels: ['dev-probe'], metadata: {} },
  ]
  assert.deepEqual(rows.filter(fleetAgentListed).map(row => row.id), [
    'fleet:ordinary',
    'fleet:label-only',
  ])
  assert.deepEqual(getFleetAgentDirectoryRows(rows).map(row => row.id), [
    'fleet:ordinary',
    'fleet:label-only',
  ])
})
