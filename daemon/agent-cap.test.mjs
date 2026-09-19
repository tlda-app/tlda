import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NO_CAP,
  agentCapCommandPlan,
  agentCapFromConfig,
  agentCapRefusal,
  awakeLocalAgentBindings,
  countAwakeLocalAgents,
} from './agent-cap.mjs'

// Shaped after the live mini ledger: `fleet-dev` is a stable bot seat that seven
// bindings have held, six of them last seen weeks ago. One process is running in
// it.
const DEV_SEAT = [
  { id: 'fleet:4c3667ac', tmuxSession: 'fleet-dev', daemonKey: 'mini:testing', lastSeen: '2026-08-13T12:58:34.307Z' },
  { id: 'fleet:458fe62d', tmuxSession: 'fleet-dev', daemonKey: 'mini:testing', lastSeen: '2026-08-15T04:03:44.494Z' },
  { id: 'fleet:1e7ed065', tmuxSession: 'fleet-dev', daemonKey: 'mini:testing', lastSeen: '2026-08-17T04:50:20.821Z' },
  { id: 'fleet:ab55db5f', tmuxSession: 'fleet-dev', daemonKey: 'mini:testing', lastSeen: '2026-08-19T06:22:08.589Z' },
  { id: 'fleet:dev', tmuxSession: 'fleet-dev', daemonKey: 'mini:testing', lastSeen: '2026-09-18T07:57:15.149Z' },
]

test('a reused session name counts as one awake agent, not one per binding that ever held it', () => {
  const awake = awakeLocalAgentBindings({
    processBindings: DEV_SEAT,
    sessionNames: ['fleet-dev'],
    daemonKey: 'mini:testing',
  })
  assert.equal(awake.length, 1)
  assert.equal(awake[0].id, 'fleet:dev', 'the current occupant is the most recently seen binding')
})

test('bindings are counted whatever order they arrive in', () => {
  const reversed = [...DEV_SEAT].reverse()
  const awake = awakeLocalAgentBindings({
    processBindings: reversed,
    sessionNames: ['fleet-dev'],
    daemonKey: 'mini:testing',
  })
  assert.equal(awake.length, 1)
  assert.equal(awake[0].id, 'fleet:dev')
})

test('a binding whose session is not running is not awake', () => {
  assert.deepEqual(awakeLocalAgentBindings({
    processBindings: DEV_SEAT,
    sessionNames: [],
    daemonKey: 'mini:testing',
  }), [])
  assert.equal(countAwakeLocalAgents({ sessionNames: [] }), 0)
})

test('another daemon on the same ledger does not occupy this box', () => {
  const awake = awakeLocalAgentBindings({
    processBindings: [
      { id: 'fleet:a', tmuxSession: 'fleet-a', daemonKey: 'mini:testing', lastSeen: '2026-09-18T00:00:00.000Z' },
      { id: 'fleet:b', tmuxSession: 'fleet-b', daemonKey: 'air:testing', lastSeen: '2026-09-18T00:00:00.000Z' },
    ],
    sessionNames: ['fleet-a', 'fleet-b'],
    daemonKey: 'mini:testing',
  })
  assert.deepEqual(awake.map(row => row.id), ['fleet:a'])
})

// The cap bounds the box, so a running session counts whether or not the ledger
// knows about it. On the mini, six running sessions had no binding -- four fleet
// bots and two leftovers -- and a ledger-only count missed every one.
test('a running session with no binding still counts against the cap', () => {
  assert.equal(countAwakeLocalAgents({
    sessionNames: ['fleet-launch-control', 'fleet-chat-lint-95', 'picpreview-logs'],
  }), 3)
})

test('the same session named twice is one thing on the box', () => {
  assert.equal(countAwakeLocalAgents({ sessionNames: ['fleet-a', 'fleet-a', 'fleet-b'] }), 2)
})

test('a failed tmux probe refuses instead of reading as an empty box', () => {
  const awake = countAwakeLocalAgents({ sessionNames: [], probed: false })
  assert.equal(awake, null, 'an unknown count must not be reported as zero')

  const refusal = agentCapRefusal('mint', {
    cap: 50,
    awake,
    daemonKey: 'mini:testing',
    probeError: 'no server running on /tmp/tlda-tmux',
  })
  assert.match(refusal, /unknown/)
  assert.match(refusal, /no server running on \/tmp\/tlda-tmux/, 'the refusal carries what tmux said')
})

test('cap 0 refuses every launch, including on an empty box', () => {
  assert.match(agentCapRefusal('mint', { cap: 0, awake: 0 }), /cap is 0/)
})

test('no cap never refuses, however many are awake', () => {
  assert.equal(agentCapRefusal('mint', { cap: NO_CAP, awake: 500 }), null)
  assert.equal(agentCapRefusal('mint', { cap: NO_CAP, awake: null }), null)
})

test('a launch under the cap is not refused, and the boundary is at the cap', () => {
  assert.equal(agentCapRefusal('mint', { cap: 50, awake: 49 }), null)
  assert.match(agentCapRefusal('mint', { cap: 50, awake: 50 }), /50 agents awake/)
})

test('the refusal says nothing was queued and names the cap that would admit it', () => {
  const refusal = agentCapRefusal('wake', { cap: 42, awake: 55, daemonKey: 'mini:testing' })
  assert.match(refusal, /declined, not deferred/)
  assert.match(refusal, /tlda agent cap 56/)
})

test('agentCap absent means no cap; a bad value is rejected rather than coerced', () => {
  assert.equal(agentCapFromConfig({}), NO_CAP)
  assert.equal(agentCapFromConfig({ agentCap: null }), NO_CAP)
  assert.equal(agentCapFromConfig({ agentCap: 0 }), 0)
  assert.throws(() => agentCapFromConfig({ agentCap: -1 }), /non-negative integer/)
  assert.throws(() => agentCapFromConfig({ agentCap: '12' }), /non-negative integer/)
  assert.throws(() => agentCapFromConfig({ agentCap: 1.5 }), /non-negative integer/)
})

// A missing CLI positional is null. `tlda agent cap` with no argument is a
// question, and answering it by writing agentCap: 0 into the live daemon.yaml
// is how this command previously capped the box to nothing.
test('a bare `agent cap` reads and never writes', () => {
  assert.deepEqual(agentCapCommandPlan(null), { action: 'read' })
  assert.deepEqual(agentCapCommandPlan(undefined), { action: 'read' })
  assert.deepEqual(agentCapCommandPlan(''), { action: 'read' })
})

test('`agent cap 0` sets a real ceiling of zero, distinct from asking', () => {
  assert.deepEqual(agentCapCommandPlan('0'), { action: 'set', cap: 0 })
  assert.deepEqual(agentCapCommandPlan(0), { action: 'set', cap: 0 })
  assert.deepEqual(agentCapCommandPlan('42'), { action: 'set', cap: 42 })
})

test('`agent cap none` removes the ceiling', () => {
  assert.deepEqual(agentCapCommandPlan('none'), { action: 'clear' })
  assert.deepEqual(agentCapCommandPlan('NONE'), { action: 'clear' })
})

test('a value that is not a count is refused rather than silently coerced', () => {
  assert.throws(() => agentCapCommandPlan('-1'), /non-negative whole number/)
  assert.throws(() => agentCapCommandPlan('1.5'), /non-negative whole number/)
  assert.throws(() => agentCapCommandPlan('lots'), /non-negative whole number/)
})

// Under `remain-on-exit` a session outlives its process: the pane goes dead and
// the name stays. On the mini this was 31 of 50 sessions at once.
test('a session whose panes are all dead is not running, and one live pane is enough', async () => {
  const { splitRunningSessions } = await import('../agent-launch/tmux.mjs')
  const { names, sessions } = splitRunningSessions([
    'fleet-launch-control\t0',
    'fleet-chief\t1',
    'fleet-new-ba\t1',
    'fleet-split\t1',
    'fleet-split\t0',
  ].join('\n'))
  assert.deepEqual(names.sort(), ['fleet-launch-control', 'fleet-split'])
  assert.equal(sessions.length, 4, 'every session is still reported as existing')
})

test('a dead-pane session does not consume a cap slot', () => {
  // `fleet-exited` still exists as a session; only `fleet-live` is running, and
  // only running sessions reach the count. On the mini this was 31 of 50.
  assert.equal(countAwakeLocalAgents({ sessionNames: ['fleet-live'] }), 1)
})

// The cap is only real if it sits on the path a process actually starts on.
test('the launch gate refuses a spawn before it does any launch work', async () => {
  const { createAgentLauncher } = await import('../agent-launch/agent-launch.mjs')
  const calls = []
  const launcher = createAgentLauncher({
    activeEnvName: 'testing',
    configDir: '/tmp/tlda-agent-cap-gate-test',
    onBeforeLaunch: () => {
      calls.push('gate')
      throw new Error('mint refused: 13 agents awake on mini:testing, cap is 13.')
    },
    loadDaemonLaunchConfig: () => ({}),
    log: { info() {}, warn() {} },
    machineId: 'test-machine',
    permissionLedger: {},
    sendMsg() {},
    getProjects: () => { calls.push('getProjects'); return [] },
    tmux() { calls.push('tmux') },
  })

  await assert.rejects(
    () => launcher.handlers.spawn({ name: 'over-the-cap', cwd: '/tmp' }),
    /cap is 13/,
  )
  assert.deepEqual(calls, ['gate'], 'nothing past the gate runs when the launch is refused')
})

test('without a gate, and with a gate that admits, the launch proceeds as before', async () => {
  const { createAgentLauncher } = await import('../agent-launch/agent-launch.mjs')
  const build = onBeforeLaunch => createAgentLauncher({
    activeEnvName: 'testing',
    configDir: '/tmp/tlda-agent-cap-gate-test',
    onBeforeLaunch,
    loadDaemonLaunchConfig: () => ({}),
    log: { info() {}, warn() {} },
    machineId: 'test-machine',
    permissionLedger: {},
    sendMsg() {},
    getProjects: () => [{ name: 'proj', sourceDir: null }],
    tmux() {},
  })

  const uncapped = await build(null).handlers.spawn({ name: 'a', project: 'proj' })
  const admitted = await build(async () => {}).handlers.spawn({ name: 'a', project: 'proj' })
  assert.deepEqual(admitted, uncapped, 'an admitting gate changes nothing about the launch')
  assert.equal(admitted.ok, false, 'and the launch still reaches its own error, not the gate’s')
})

// Bots are continuity infrastructure. The cap counts them, because they are load
// on the box, but it never refuses one -- a ceiling that can decline a bot's
// restart takes it down silently for as long as the box stays full.
test('a bot launch is recognised from either the request kind or the resolved harness', async () => {
  const { isBotLaunch } = await import('./agent-cap.mjs')
  assert.equal(isBotLaunch({ kind: 'bot' }), true, 'tlda agent mint --kind bot')
  assert.equal(isBotLaunch({ harness: 'bot' }), true, 'a wake, where the harness comes off the launch recipe')
  assert.equal(isBotLaunch({ kind: 'BOT' }), true)
  assert.equal(isBotLaunch({ kind: 'claude', harness: 'claude' }), false)
  assert.equal(isBotLaunch({}), false, 'an unmarked launch is not a bot')
  assert.equal(isBotLaunch(), false)
})

test('bots still count toward the cap, so the number describes the box', () => {
  assert.equal(countAwakeLocalAgents({
    sessionNames: ['fleet-launch-control', 'fleet-dev', 'fleet-bot-grammar_testing'],
  }), 3)
})

// The daemon decides the exemption from what the launch is, so the launcher has
// to hand the hook enough to tell. Without this the gate sees an empty object
// and every bot is treated as an ordinary agent.
test('the launch gate is told what kind of launch it is deciding about', async () => {
  const { createAgentLauncher } = await import('../agent-launch/agent-launch.mjs')
  const seen = []
  const launcher = createAgentLauncher({
    activeEnvName: 'testing',
    configDir: '/tmp/tlda-agent-cap-gate-test',
    onBeforeLaunch: launch => { seen.push(launch) },
    loadDaemonLaunchConfig: () => ({}),
    log: { info() {}, warn() {} },
    machineId: 'test-machine',
    permissionLedger: {},
    sendMsg() {},
    getProjects: () => [{ name: 'proj', sourceDir: null }],
    tmux() {},
  })
  await launcher.handlers.spawn({ name: 'grammar', kind: 'bot', project: 'proj' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].kind, 'bot', 'the gate can see this is a bot and admit it')
  assert.equal(seen[0].name, 'grammar')
})
