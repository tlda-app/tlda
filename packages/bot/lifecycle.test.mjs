import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBot, createTransportFixture } from './index.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))

const ORIGINAL_ENV = {
  TLDA_BOT_NAME: process.env.TLDA_BOT_NAME,
  TLDA_BOT_MACHINE_ID: process.env.TLDA_BOT_MACHINE_ID,
  TLDA_BOT_TMUX_SESSION: process.env.TLDA_BOT_TMUX_SESSION,
  FLEET_DAEMON_KEY: process.env.FLEET_DAEMON_KEY,
  TLDA_ENV: process.env.TLDA_ENV,
}

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
}

function loginRouteProof(payload) {
  const machineId = payload.machine_id || null
  const envName = payload.env_name || null
  const daemonKey = payload.daemon_key || (machineId && envName ? `${machineId}:${envName}` : null)
  if (!daemonKey) return null
  const keyParts = daemonKey.split(':')
  const resolvedMachineId = machineId || keyParts[0] || null
  const resolvedEnvName = envName || keyParts.slice(1).join(':') || null
  if (!resolvedMachineId || !resolvedEnvName) return null
  if (machineId && envName && daemonKey !== `${machineId}:${envName}`) {
    throw new Error(`login daemon route mismatch: daemon_key ${daemonKey} does not match ${machineId}:${envName}`)
  }
  return {
    daemon_key: daemonKey,
    machine_id: resolvedMachineId,
    env_name: resolvedEnvName,
  }
}

async function login(socket, assignedName, id = 'fleet:fixture') {
  await turn()
  const request = socket.sent.find(message => message.type === 'login')
  assert.ok(request)
  assert.equal(request.kind, 'bot')
  assert.equal(request.metadata.model, 'fixture')
  assert.deepEqual(request.labels, ['bot'])
  socket.reply(request, { ok: true, agent: { id, friendly_name: assignedName } })
  await turn()
  const subscription = socket.sent.find(message => message.type === 'subscribe-filter')
  if (assignedName === 'fixture') {
    assert.ok(subscription)
    assert.deepEqual(subscription.filter, [[['to', id]], [['from', id]]])
  }
  if (subscription) socket.reply(subscription, { ok: true })
  await turn()
}

test('transport fixture proves inertness, commands, help, unknown help, and reconnect', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  let handled = 0
  let messages = 0
  const bot = createBot({
    name: 'fixture',
    fleetId: 'fleet:fixture',
    pidFile: join(directory, 'fixture.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
    reconnectInitialMs: 1,
    reconnectMaxMs: 1,
    commands: [{
      name: 'probe',
      summary: 'Run a probe.',
      help: 'Runs the probe once.',
      handler: async ({ reply }) => {
        handled++
        await reply('probed')
      },
    }],
  }).onMessage(() => { messages++ }).start()
  t.after(() => bot.stop())

  await login(transport.sockets[0], 'fixture-2')
  transport.sockets[0].event({ event: 'fleet-event', data: {
    type: 'chat', from_id: 'fleet:user', recipients: ['fleet:fixture'], text: 'probe',
  } })
  await turn()
  assert.equal(handled, 0)
  assert.equal(transport.sockets[0].sent.some(message => message.type === 'chat'), false)

  transport.sockets[0].event({ event: 'agents-delta', data: {
    changed: [{ id: 'fleet:fixture', friendly_name: 'fixture' }],
  } })
  transport.sockets[0].event({ event: 'filter-event', data: { subId: 'bot-chat-fleet:fixture', event: {
    type: 'chat', from_id: 'fleet:user', recipients: ['fleet:fixture'], text: 'probe',
  } } })
  await turn()
  assert.equal(handled, 1)
  assert.equal(messages, 1)
  for (const text of ['help', 'missing']) {
    transport.sockets[0].event({ event: 'fleet-event', data: {
      type: 'chat', from_id: 'fleet:user', recipients: ['fleet:fixture'], text,
    } })
    await turn()
  }
  assert.equal(handled, 1)
  const replies = transport.sockets[0].sent.filter(message => message.type === 'chat').map(message => message.message)
  assert.deepEqual(replies.slice(0, 2), ['probed', 'Available commands:\n- `probe` — Run a probe.\n\nUse `help <command>` for details.'])
  assert.match(replies[2], /Unknown command `missing`/)

  transport.sockets[0].close()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(transport.sockets.length, 2)
  await login(transport.sockets[1], 'fixture')
})

test('bot registration does not duplicate its friendly name as an explicit label', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  const bot = createBot({
    name: 'todd',
    labels: ['bot', 'todd', 'bot'],
    fleetId: 'fleet:todd-fixture',
    pidFile: join(directory, 'todd.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).start()
  t.after(() => bot.stop())

  await turn()
  const login = transport.sockets[0].sent.find(message => message.type === 'login')
  assert.ok(login)
  assert.equal(login.name, 'todd')
  assert.deepEqual(login.labels, ['bot'])
})

test('bot login sends daemon route proof required by the receive gate', async t => {
  restoreEnv()
  t.after(restoreEnv)
  process.env.TLDA_BOT_MACHINE_ID = 'mini'
  process.env.TLDA_BOT_TMUX_SESSION = 'fleet-bot-fixture_testing'
  process.env.FLEET_DAEMON_KEY = 'mini:testing'
  process.env.TLDA_ENV = 'testing'

  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  const bot = createBot({
    name: 'fixture',
    fleetId: 'fleet:fixture',
    pidFile: join(directory, 'fixture.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).start()
  t.after(() => bot.stop())

  await turn()
  const login = transport.sockets[0].sent.find(message => message.type === 'login')
  assert.ok(login)
  assert.equal(login.machine_id, 'mini')
  assert.equal(login.env_name, 'testing')
  assert.equal(login.daemon_key, 'mini:testing')
  assert.equal(login.tmux_session, 'fleet-bot-fixture_testing')
  assert.equal(loginRouteProof(login).daemon_key, 'mini:testing')
})

test('bot login route proof also works from machine and env when daemon key is absent', async t => {
  restoreEnv()
  t.after(restoreEnv)
  process.env.TLDA_BOT_MACHINE_ID = 'mini'
  process.env.TLDA_ENV = 'testing'
  delete process.env.FLEET_DAEMON_KEY

  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  const bot = createBot({
    name: 'fixture',
    fleetId: 'fleet:fixture',
    pidFile: join(directory, 'fixture.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).start()
  t.after(() => bot.stop())

  await turn()
  const login = transport.sockets[0].sent.find(message => message.type === 'login')
  assert.ok(login)
  assert.equal(login.machine_id, 'mini')
  assert.equal(login.env_name, 'testing')
  assert.equal(login.daemon_key, undefined)
  assert.equal(loginRouteProof(login).daemon_key, 'mini:testing')
})

// Skip, 2026-08-13: "I think all bots should probably carry the bot label." The
// label is what todd's don't-nudge-a-bot guard tests, so a caller that forgets it
// produces a bot that gets kicked like a person. These pin the assertion to the
// harness rather than to every bot's call site.
test('a bot carries the bot label even when the caller asks for none', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  const bot = createBot({
    name: 'forgetful',
    labels: [],
    fleetId: 'fleet:forgetful-fixture',
    pidFile: join(directory, 'forgetful.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).start()
  t.after(() => bot.stop())

  await turn()
  const login = transport.sockets[0].sent.find(message => message.type === 'login')
  assert.ok(login)
  // Not merely "contains bot" — an empty array is truthy, and the server's login
  // writes `labels || existing.labels || []`, so sending [] would clear the row.
  assert.deepEqual(login.labels, ['bot'])
})

test('the bot label leads, and the caller’s own labels survive beside it', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  const bot = createBot({
    name: 'teacher',
    labels: ['drill'],
    fleetId: 'fleet:teacher-fixture',
    pidFile: join(directory, 'teacher.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).start()
  t.after(() => bot.stop())

  await turn()
  const login = transport.sockets[0].sent.find(message => message.type === 'login')
  assert.ok(login)
  assert.deepEqual(login.labels, ['bot', 'drill'])
})

test('a human participant is not a bot and does not get the label', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  const bot = createBot({
    name: 'skip',
    human: true,
    labels: [],
    fleetId: 'fleet:human-fixture',
    pidFile: join(directory, 'human.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).start()
  t.after(() => bot.stop())

  await turn()
  const register = transport.sockets[0].sent.find(message => message.type === 'register')
  assert.ok(register)
  assert.deepEqual(register.labels, [])
})

// Skip, 2026-08-13: "Inertness should gate the entirety of bot behavior." A bot
// silenced by rename was still running whatever it armed in `onOpen` — dev's
// preview sweep, for one. These pin the gate to the harness.
test('an inert bot never runs its open hook, so its own work never starts', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  let opened = 0
  const bot = createBot({
    name: 'fixture',
    fleetId: 'fleet:inert-fixture',
    pidFile: join(directory, 'inert.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).onOpen(() => { opened++ }).start()
  t.after(() => bot.stop())

  // The allocator hands back a name that is not the one asked for — the
  // sanctioned stop for a runaway bot.
  await login(transport.sockets[0], 'quiet-fixture', 'fleet:inert-fixture')
  assert.equal(bot.canonical, false)
  assert.equal(opened, 0)
})

test('a canonical bot still runs its open hook', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-bot-'))
  const transport = createTransportFixture()
  let opened = 0
  const bot = createBot({
    name: 'fixture',
    fleetId: 'fleet:live-fixture',
    pidFile: join(directory, 'live.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).onOpen(() => { opened++ }).start()
  t.after(() => bot.stop())

  await login(transport.sockets[0], 'fixture', 'fleet:live-fixture')
  assert.equal(bot.canonical, true)
  assert.equal(opened, 1)
})
