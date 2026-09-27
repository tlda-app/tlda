import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSpawnMachine } from './spawn-routing.mjs'

const daemonConnections = (entries = [['mini', 'testing'], ['air', 'testing']]) =>
  new Map(entries.map(([machine, env]) => [`${machine}:${env}`, { _machineId: machine, _envName: env }]))
const noPrefs = { getFleetPref: async () => null }

test('a caller with a route mints to its own machine with two daemons connected', async () => {
  const route = await resolveSpawnMachine({
    caller: { id: 'fleet:minter', human: false, route_daemon_key: 'mini:testing' },
    fresh: true,
    fleetStore: noPrefs,
    daemonConnections: daemonConnections(),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.env_name, 'testing')
  assert.equal(route.source, 'agent-own-machine')
})

test('a legacy caller carrying machine_id still routes (plain-object compat)', async () => {
  const route = await resolveSpawnMachine({
    caller: { id: 'fleet:legacy', human: false, machine_id: 'air', env_name: 'testing' },
    fresh: true,
    fleetStore: noPrefs,
    daemonConnections: daemonConnections(),
  })
  assert.equal(route.machine_id, 'air')
  assert.equal(route.env_name, 'testing')
  assert.equal(route.source, 'agent-own-machine')
})

test('a wake routes to the target route with two daemons connected', async () => {
  const route = await resolveSpawnMachine({
    caller: { id: 'fleet:minter', human: false },
    targetAgent: { id: 'fleet:sleeper', route_daemon_key: 'air:testing' },
    respawn: true,
    fleetStore: noPrefs,
    daemonConnections: daemonConnections(),
  })
  assert.equal(route.machine_id, 'air')
  assert.equal(route.env_name, 'testing')
  assert.equal(route.source, 'target-agent-machine')
})

test('a routeless caller with two daemons fails offering the choice it knows', async () => {
  await assert.rejects(
    () => resolveSpawnMachine({
      caller: { id: 'fleet:noroute', human: false },
      fresh: true,
      fleetStore: noPrefs,
      daemonConnections: daemonConnections(),
    }),
    /spawn_machine_id to one of: mini:testing, air:testing.*tlda agent set-mint-machine fleet:noroute/,
  )
})

test('a human with a route takes the same own-machine path (no special-casing)', async () => {
  const route = await resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, route_daemon_key: 'mini:testing' },
    fresh: true,
    fleetStore: noPrefs,
    daemonConnections: daemonConnections(),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.source, 'agent-own-machine')
})

test('a human without a route takes the same offered-choice failure', async () => {
  await assert.rejects(
    () => resolveSpawnMachine({
      caller: { id: 'fleet:skip', human: true },
      fresh: true,
      fleetStore: noPrefs,
      daemonConnections: daemonConnections(),
    }),
    /spawn_machine_id to one of: mini:testing, air:testing/,
  )
})

test('a sole connected daemon still revives an address-less seat', async () => {
  const route = await resolveSpawnMachine({
    caller: { id: 'fleet:minter', human: false },
    targetAgent: { id: 'fleet:sleeper' },
    respawn: true,
    fleetStore: noPrefs,
    daemonConnections: daemonConnections([['mini', 'testing']]),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.source, 'target-agent-machine-defaulted')
})

test('a route pointing at a disconnected daemon fails naming the key', async () => {
  await assert.rejects(
    () => resolveSpawnMachine({
      caller: { id: 'fleet:minter', human: false, route_daemon_key: 'mini:testing' },
      fresh: true,
      fleetStore: noPrefs,
      daemonConnections: daemonConnections([['air', 'testing']]),
    }),
    /No fleet daemon connected for "mini:testing"/,
  )
})
