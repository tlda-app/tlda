import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBot, createTransportFixture } from './index.mjs'
import { createMuteState, isMutedByLabels, shutUpLabel } from './mute.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await turn() }

test('shutUpLabel names the contract label, lowercased', () => {
  assert.equal(shutUpLabel('todd'), 'shut-up-todd')
  assert.equal(shutUpLabel('Todd'), 'shut-up-todd')
})

test('isMutedByLabels matches the exact label only', () => {
  assert.equal(isMutedByLabels(['bot', 'shut-up-todd'], 'todd'), true)
  assert.equal(isMutedByLabels(['bot', 'shut-up-dev'], 'todd'), false)
  assert.equal(isMutedByLabels(['shut up, todd'], 'todd'), false)
  assert.equal(isMutedByLabels([], 'todd'), false)
  assert.equal(isMutedByLabels(null, 'todd'), false)
  assert.equal(isMutedByLabels(undefined, 'todd'), false)
})

test('filter suppresses the muted id and delivers the rest, synchronously', () => {
  const lines = []
  const mute = createMuteState({ botKey: 'todd', log: (line) => lines.push(line) })
  mute.noteAgents([
    { id: 'fleet:muted', labels: ['shut-up-todd'] },
    { id: 'fleet:loud', labels: ['bot'] },
  ])
  // No await anywhere in this test: the filter runs on the calling tick, which
  // is the property main's send-state suite depends on.
  const { deliver, suppressed, unknown } = mute.filter(['fleet:muted', 'fleet:loud'])
  assert.deepEqual(deliver, ['fleet:loud'])
  assert.deepEqual(suppressed, ['fleet:muted'])
  assert.deepEqual(unknown, [])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /fleet:muted/)
  assert.match(lines[0], /shut-up-todd/)
})

test('filter delivers unknown ids and non-id recipients, and names the unknowns', () => {
  const mute = createMuteState({ botKey: 'todd' })
  mute.noteAgents([{ id: 'fleet:loud', labels: [] }])
  const { deliver, suppressed, unknown } = mute.filter(['fleet:ghost', 'awake', 'fleet:loud'])
  assert.deepEqual(deliver, ['fleet:ghost', 'awake', 'fleet:loud'])
  assert.deepEqual(suppressed, [])
  assert.deepEqual(unknown, ['fleet:ghost'])
})

test('filter treats expired entries as unknown, so an unmuted agent stops being muted', () => {
  let t = 1_000_000
  const mute = createMuteState({ botKey: 'todd', maxAgeMs: 60_000, now: () => t })
  mute.noteAgents([{ id: 'fleet:fickle', labels: ['shut-up-todd'] }])
  assert.deepEqual(mute.filter('fleet:fickle').suppressed, ['fleet:fickle'])
  t += 60_001
  const { deliver, suppressed, unknown } = mute.filter('fleet:fickle')
  assert.deepEqual(deliver, ['fleet:fickle'])
  assert.deepEqual(suppressed, [])
  assert.deepEqual(unknown, ['fleet:fickle'])
})

test('warm batches one tick of misses into a single lookup and notes the answer', async () => {
  let calls = 0
  const mute = createMuteState({
    botKey: 'todd',
    fetchLabels: async (ids) => {
      calls++
      assert.deepEqual([...ids].sort(), ['fleet:a', 'fleet:b'])
      return new Map([['fleet:a', ['shut-up-todd']], ['fleet:b', []]])
    },
  })
  mute.warm(['fleet:a'])
  mute.warm(['fleet:a', 'fleet:b'])
  await flush()
  assert.equal(calls, 1)
  const { deliver, suppressed } = mute.filter(['fleet:a', 'fleet:b'])
  assert.deepEqual(deliver, ['fleet:b'])
  assert.deepEqual(suppressed, ['fleet:a'])
})

test('warm failures stay silent and leave the ids unknown', async () => {
  const mute = createMuteState({
    botKey: 'todd',
    fetchLabels: async () => { throw new Error('boom') },
  })
  mute.warm('fleet:a')
  await flush()
  assert.deepEqual(mute.filter('fleet:a').unknown, ['fleet:a'])
})

// The harness end: a canonical bot's chat() suppresses the muted recipient and
// still reaches the unmuted one in the same call, on the same tick. The labels
// arrive the way production feeds them — an agents-delta batch — so this test
// exercises the whole path the row promises with no HTTP anywhere.
test('createBot.chat suppresses per recipient from delta-fed labels, synchronously', async () => {
  const { WebSocketClass, sockets } = createTransportFixture()
  const bot = createBot({
    name: 'fixture',
    fleetId: 'fleet:fixture',
    server: 'http://fixture.invalid',
    pidFile: join(mkdtempSync(join(tmpdir(), 'mute-test-')), 'bot.pid'),
    WebSocketClass,
    livenessProbeIntervalMs: 0,
    canonicalRefreshIntervalMs: 0,
  })
  try {
    bot.start()
    await turn()
    const socket = sockets[0]
    const login = socket.sent.find(m => m.type === 'login')
    socket.reply(login, { ok: true, agent: { id: 'fleet:fixture', friendly_name: 'fixture', labels: ['bot'] } })
    await flush()
    assert.ok(bot.isCanonical())

    socket.event({
      event: 'agents-delta',
      data: { changed: [
        { id: 'fleet:muted', labels: ['shut-up-fixture'] },
        { id: 'fleet:loud', labels: ['bot'] },
      ] },
    })
    await turn()

    bot.chat(['fleet:muted', 'fleet:loud'], 'hello both')
    // Zero-tick assert, like send-state's: the write must already be out.
    const chats = socket.sent.filter(m => m.type === 'chat')
    assert.equal(chats.length, 1)
    assert.deepEqual(chats[0].to, ['fleet:loud'])
  } finally {
    bot.stop()
  }
})

test('createBot.chat sends nothing when every recipient is muted', async () => {
  const { WebSocketClass, sockets } = createTransportFixture()
  const bot = createBot({
    name: 'fixture',
    fleetId: 'fleet:fixture',
    server: 'http://fixture.invalid',
    pidFile: join(mkdtempSync(join(tmpdir(), 'mute-test-')), 'bot.pid'),
    WebSocketClass,
    livenessProbeIntervalMs: 0,
    canonicalRefreshIntervalMs: 0,
  })
  try {
    bot.start()
    await turn()
    const socket = sockets[0]
    const login = socket.sent.find(m => m.type === 'login')
    socket.reply(login, { ok: true, agent: { id: 'fleet:fixture', friendly_name: 'fixture', labels: ['bot'] } })
    await flush()

    socket.event({
      event: 'agents-delta',
      data: { changed: [{ id: 'fleet:muted', labels: ['shut-up-fixture'] }] },
    })
    await turn()

    bot.chat('fleet:muted', 'hello muted')
    assert.deepEqual(socket.sent.filter(m => m.type === 'chat'), [])
  } finally {
    bot.stop()
  }
})
