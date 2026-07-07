import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSpawnMachine, SPAWN_MACHINE_PREF_KEY } from '../server/lib/spawn-routing.mjs'

function store(prefs = {}) {
  return {
    getFleetPref(userId, key) {
      return prefs[`${userId}:${key}`]
    },
    setFleetPref(userId, key, value) {
      prefs[`${userId}:${key}`] = value
    },
  }
}

function daemons(...machineIds) {
  return new Map(machineIds.map(id => {
    const [machineId, envName] = id.split(':')
    return [id, { readyState: 1, _machineId: machineId, _envName: envName }]
  }))
}

test('fresh human spawn routes to configured spawn machine and uses the daemon env', () => {
  const caller = { id: 'fleet:skip', human: true, machine_id: 'ipad' }
  const prefs = { [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'air' }
  const route = resolveSpawnMachine({
    caller,
    fresh: true,
    fleetStore: store(prefs),
    daemonConnections: daemons('air:stable', 'ipad:unstable'),
  })
  assert.equal(route.machine_id, 'air')
  assert.equal(route.env_name, 'stable')
  assert.equal(route.source, 'caller-configured-spawn-machine')
  assert.equal(prefs[`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`], 'air:stable')
})

test('fresh human spawn routes machine-only mini pref to connected mini daemon and normalizes it', () => {
  const caller = { id: 'fleet:skip', human: true, machine_id: null, env_name: null }
  const prefs = { [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'mini' }
  const route = resolveSpawnMachine({
    caller,
    fresh: true,
    fleetStore: store(prefs),
    daemonConnections: daemons('mini:default'),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.env_name, 'default')
  assert.equal(route.source, 'caller-configured-spawn-machine')
  assert.equal(prefs[`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`], 'mini:default')
})

test('fresh human spawn routes already-normalized daemon pref directly', () => {
  const caller = { id: 'fleet:skip', human: true, machine_id: null, env_name: null }
  const prefs = { [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'mini:default' }
  const route = resolveSpawnMachine({
    caller,
    fresh: true,
    fleetStore: store(prefs),
    daemonConnections: daemons('mini:default'),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.env_name, 'default')
  assert.equal(route.source, 'caller-configured-spawn-machine')
  assert.equal(prefs[`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`], 'mini:default')
})

test('fresh non-human spawn defaults to the agent own machine', () => {
  const caller = { id: 'fleet:worker', human: false, machine_id: 'mini', env_name: 'stable' }
  const route = resolveSpawnMachine({
    caller,
    fresh: true,
    fleetStore: store(),
    daemonConnections: daemons('air:unstable', 'mini:stable'),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.env_name, 'stable')
  assert.equal(route.source, 'agent-own-machine')
})

test('fresh non-human default routes own machine through connected daemon when env is missing', () => {
  const caller = { id: 'fleet:worker', human: false, machine_id: 'mini', env_name: null }
  const route = resolveSpawnMachine({
    caller,
    fresh: true,
    fleetStore: store(),
    daemonConnections: daemons('mini:default', 'air:stable'),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.env_name, 'default')
  assert.equal(route.source, 'agent-own-machine')
})

test('respawn routes to target agent machine', () => {
  const route = resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad', env_name: 'unstable' },
    targetAgent: { id: 'fleet:target', machine_id: 'mini', env_name: 'stable' },
    respawn: true,
    fleetStore: store({ [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'air' }),
    daemonConnections: daemons('air:unstable', 'mini:stable', 'ipad:unstable'),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.env_name, 'stable')
  assert.equal(route.source, 'target-agent-machine')
})

test('anchored fresh spawn routes to route agent machine without respawn semantics', () => {
  const route = resolveSpawnMachine({
    caller: { id: 'fleet:todd', human: true, machine_id: null },
    targetAgent: { id: 'fleet:stale-worker', machine_id: 'mini', env_name: 'stable' },
    fresh: true,
    fleetStore: store(),
    daemonConnections: daemons('air:unstable', 'mini:stable'),
  })
  assert.equal(route.machine_id, 'mini')
  assert.equal(route.env_name, 'stable')
  assert.equal(route.source, 'route-agent-machine')
})

test('missing configured human spawn machine uses sole connected daemon as documented bootstrap default', () => {
  const route = resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad' },
    fresh: true,
    fleetStore: store(),
    daemonConnections: daemons('air:stable'),
  })
  assert.equal(route.machine_id, 'air')
  assert.equal(route.env_name, 'stable')
  assert.equal(route.source, 'sole-connected-daemon')
})

test('missing configured human spawn machine fails loud with multiple daemons', () => {
  assert.throws(() => resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad' },
    fresh: true,
    fleetStore: store(),
    daemonConnections: daemons('air:stable', 'mini:stable'),
  }), /spawn machine is not configured.*spawn_machine_id/)
})

test('missing configured human spawn machine fails loud with multiple envs on one machine', () => {
  assert.throws(() => resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad' },
    fresh: true,
    fleetStore: store(),
    daemonConnections: daemons('air:stable', 'air:unstable'),
  }), /air:stable, air:unstable/)
})

test('welcomed daemon map entry is routable by the same resolver', () => {
  const daemonConnections = new Map()
  const welcomedDaemonWs = { readyState: 1 }
  welcomedDaemonWs._machineId = 'air'
  welcomedDaemonWs._envName = 'stable'
  daemonConnections.set('air:stable', welcomedDaemonWs)

  const route = resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad' },
    fresh: true,
    fleetStore: store({ [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'air' }),
    daemonConnections,
  })
  assert.equal(route.machine_id, 'air')
  assert.equal(route.env_name, 'stable')
  assert.equal(daemonConnections.get(`${route.machine_id}:${route.env_name}`), welcomedDaemonWs)
})

test('configured spawn machine must be connected', () => {
  assert.throws(() => resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad' },
    fresh: true,
    fleetStore: store({ [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'air' }),
    daemonConnections: daemons('mini:stable'),
  }), /No fleet daemon connected for machine "air"/)
})

test('missing configured daemon invokes observability hook before failing', () => {
  const misses = []
  assert.throws(() => resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad' },
    fresh: true,
    fleetStore: store({ [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'air' }),
    daemonConnections: daemons('mini:stable'),
    onDaemonMissing: (...args) => misses.push(args),
  }), /No fleet daemon connected for machine "air"/)
  assert.equal(misses.length, 1)
  assert.equal(misses[0][0], 'air')
  assert.match(misses[0][1], /configured spawn machine/)
})

test('configured spawn machine fails loud when multiple daemon envs match', () => {
  assert.throws(() => resolveSpawnMachine({
    caller: { id: 'fleet:skip', human: true, machine_id: 'ipad' },
    fresh: true,
    fleetStore: store({ [`fleet:skip:${SPAWN_MACHINE_PREF_KEY}`]: 'air' }),
    daemonConnections: daemons('air:stable', 'air:unstable'),
  }), /multiple daemon environments configured for "air".*air:stable, air:unstable/)
})
