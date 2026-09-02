// A rename is the sanctioned bot stop, and it has to work in both directions
// with no lifecycle call. These tests drive the roster only — no `agents-delta`
// event, no reconnect, no restart — because the delta is exactly what was not
// arriving on a loaded bot, and a restart is the workaround Skip rejected.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBot, createTransportFixture } from './index.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
const ID = 'fleet:recheck'

// Stands in for GET /api/agents/lookup. `rosterName` is the authority the bot
// reads; the tests move it and nothing else.
function stubRoster(t, initial) {
  const state = { rosterName: initial, calls: 0 }
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = new URL(url)
    assert.equal(target.pathname, '/api/agents/lookup')
    assert.equal(target.searchParams.get('ids'), ID)
    state.calls++
    return {
      ok: true,
      json: async () => ({ agents: [{ id: ID, friendly_name: state.rosterName }] }),
    }
  }
  t.after(() => { globalThis.fetch = original })
  return state
}

async function loginAs(socket, assignedName) {
  await turn()
  const request = socket.sent.find(message => message.type === 'login')
  assert.ok(request, 'bot should have sent a login')
  socket.reply(request, { ok: true, agent: { id: ID, friendly_name: assignedName } })
  await turn()
  const subscription = socket.sent.find(message => message.type === 'subscribe-filter')
  if (subscription) socket.reply(subscription, { ok: true })
  await turn()
}

function startBot(t, { canonicalRefreshIntervalMs = 0 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tlda-recheck-'))
  const transport = createTransportFixture()
  const opens = []
  const bot = createBot({
    name: 'recheck',
    fleetId: ID,
    pidFile: join(directory, 'recheck.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
    reconnectInitialMs: 1,
    reconnectMaxMs: 1,
    livenessProbeIntervalMs: 0,
    canonicalRefreshIntervalMs,
  }).onOpen(() => { opens.push(Date.now()) }).start()
  t.after(() => bot.stop())
  return { bot, transport, opens }
}

test('a rename away from the canonical name stops the bot from the roster alone', async t => {
  const roster = stubRoster(t, 'recheck')
  const { bot, transport } = startBot(t)
  const socket = transport.sockets[0]
  await loginAs(socket, 'recheck')
  assert.equal(bot.isCanonical(), true)

  bot.chat('fleet:user', 'still working')
  await turn()
  assert.equal(socket.sent.filter(m => m.type === 'chat').length, 1)

  // The rename. No event is delivered to the socket — the roster is the only
  // thing that changed, and reading it is the whole mechanism under test.
  roster.rosterName = 'quiet-recheck'
  assert.equal(await bot.refreshAssignedName(), false)
  assert.equal(bot.isCanonical(), false)
  assert.equal(bot.assignedName, 'quiet-recheck')

  bot.chat('fleet:user', 'should never be sent')
  await turn()
  assert.equal(socket.sent.filter(m => m.type === 'chat').length, 1)
})

test('a rename back resumes the bot: resubscribe and re-fire open, no restart', async t => {
  const roster = stubRoster(t, 'quiet-recheck')
  const { bot, transport, opens } = startBot(t)
  const socket = transport.sockets[0]

  // Started inert, exactly as dev and todd were from 2026-08-26. Login skips the
  // subscription and `open` never fires, so the bot is deaf and unarmed.
  await loginAs(socket, 'quiet-recheck')
  assert.equal(bot.isCanonical(), false)
  assert.equal(opens.length, 0)
  assert.equal(socket.sent.some(m => m.type === 'subscribe-filter'), false)

  roster.rosterName = 'recheck'
  const refresh = bot.refreshAssignedName()
  await turn()
  const subscription = socket.sent.find(m => m.type === 'subscribe-filter')
  assert.ok(subscription, 'becoming canonical must take out the subscription login skipped')
  assert.deepEqual(subscription.filter, [[['to', ID]], [['from', ID]]])
  socket.reply(subscription, { ok: true })
  assert.equal(await refresh, true)

  // `open` is where dev arms its sweep and nobody its poll. Without this the
  // process has to be killed to make the rename back take effect.
  assert.equal(opens.length, 1)
  assert.equal(bot.isCanonical(), true)

  bot.chat('fleet:user', 'resumed')
  await turn()
  assert.equal(socket.sent.filter(m => m.type === 'chat').length, 1)
})

test('the canonical watch is armed for an inert bot, not only a canonical one', async t => {
  const roster = stubRoster(t, 'quiet-recheck')
  const { bot, transport, opens } = startBot(t, { canonicalRefreshIntervalMs: 5 })
  const socket = transport.sockets[0]
  await loginAs(socket, 'quiet-recheck')
  assert.equal(bot.isCanonical(), false)

  // A watch that only ran while canonical could never notice this.
  roster.rosterName = 'recheck'
  const deadline = Date.now() + 2000
  while (!opens.length && Date.now() < deadline) {
    const subscription = socket.sent.find(m => m.type === 'subscribe-filter')
    if (subscription) socket.reply(subscription, { ok: true })
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(bot.isCanonical(), true, 'the periodic refresh must resume an inert bot on its own')
  assert.equal(opens.length, 1)
})

test('a roster lookup that answers nothing leaves the cached assignment alone', async t => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
  t.after(() => { globalThis.fetch = original })

  const { bot, transport } = startBot(t)
  await loginAs(transport.sockets[0], 'recheck')
  assert.equal(bot.isCanonical(), true)

  await assert.rejects(() => bot.refreshAssignedName(), /agent lookup failed: HTTP 503/)
  assert.equal(bot.isCanonical(), true, 'silence must not revoke canonicality from a working bot')
})
