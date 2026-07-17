import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  getFleetAgentDirectoryRows,
  sortFleetAgentDirectoryRows,
} from '../src/shapes/FleetAgentDirectoryModel.ts'
import {
  FleetAgentDirectoryList,
} from '../src/shapes/FleetAgentDirectoryRow.tsx'
import { fleetAgentFilterChoiceUpdate } from '../src/shapes/fleet-agent-filter-choices.ts'

const roster = [
  { id: 'fleet:id-only', runtime_status: { status: 'awake' }, labels: ['reviewers'], last_seen: '2026-07-16T12:00:00.000Z' },
  { id: 'fleet:skip', runtime_status: { status: 'human' }, human: true, labels: ['owner'], last_seen: '2026-07-16T12:00:00.000Z' },
  { id: '7.0', runtime_status: { status: 'awake' }, labels: ['junk-id'], last_seen: '2026-07-16T12:00:00.000Z' },
  { id: 'fleet:dead', friendly_name: 'dead', runtime_status: { status: 'dead' }, dead: true, labels: ['hidden'], last_seen: '2026-07-16T12:00:00.000Z' },
]

test('filter mode uses the agents-directory row model without friendly_name-only filtering', () => {
  const rows = sortFleetAgentDirectoryRows(getFleetAgentDirectoryRows(roster))
  const names = rows.map(row => row.exactName).sort()

  assert.deepEqual(names, ['7.0', 'id-only', 'skip'])
  assert.equal(rows.some(row => row.exactName === 'dead'), false)
  assert.equal(rows.find(row => row.exactName === 'id-only')?.displayName, 'id-only')
  assert.deepEqual(rows.find(row => row.exactName === 'id-only')?.labels, ['reviewers'])
})

test('filter mode renders shared agents-directory rows, labels, human rows, and junk ids', () => {
  const rows = sortFleetAgentDirectoryRows(getFleetAgentDirectoryRows(roster))
  const html = renderToStaticMarkup(React.createElement(FleetAgentDirectoryList, { rows }))

  assert.match(html, /fleet-agents-row/)
  assert.match(html, /data-agent-name="id-only"/)
  assert.match(html, /reviewers/)
  assert.match(html, /data-agent-name="skip"/)
  assert.match(html, /data-agent-name="7\.0"/)
  assert.doesNotMatch(html, /data-agent-name="dead"/)
})

test('filter mode empty roster renders the ordinary agents empty state', () => {
  const html = renderToStaticMarkup(React.createElement(FleetAgentDirectoryList, { rows: [] }))
  assert.match(html, /fleet-agents-empty/)
  assert.match(html, /No agents/)
})

test('selecting an agents-directory row updates the same chat filter props', () => {
  const shape = { props: { filter: [], trafficMode: 'normal' } }
  const updateChatProps = (props) => { shape.props = { ...shape.props, ...props } }

  updateChatProps(fleetAgentFilterChoiceUpdate('skip', 'id-only', 'dm'))
  assert.deepEqual(shape.props, {
    filter: [[['dm', 'id-only']]],
    trafficMode: 'normal',
  })

  updateChatProps(fleetAgentFilterChoiceUpdate('skip', 'reviewers', 'agent'))
  assert.deepEqual(shape.props, {
    filter: [[['from', 'reviewers']], [['to', 'reviewers']]],
    trafficMode: 'normal',
  })
})
