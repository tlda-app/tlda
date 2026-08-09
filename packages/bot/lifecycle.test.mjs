import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBot, createTransportFixture } from './index.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))

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
    idFile: join(directory, 'fixture.id'),
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
    idFile: join(directory, 'todd.id'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
  }).start()
  t.after(() => bot.stop())

  await turn()
  const reservation = transport.sockets[0].sent.find(message => message.type === 'reserve-shell')
  assert.ok(reservation)
  assert.equal(reservation.name, 'todd')
  assert.deepEqual(reservation.labels, ['bot'])
})
