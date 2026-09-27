import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBot, createTransportFixture } from './index.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const SAVED_ENV = {
  TLDA_BOT_NAME: process.env.TLDA_BOT_NAME,
  TLDA_BOT_HEARTBEAT: process.env.TLDA_BOT_HEARTBEAT,
}

function pinEnv() {
  process.env.TLDA_BOT_NAME = 'sendprobe'
  delete process.env.TLDA_BOT_HEARTBEAT
}

function restoreEnv() {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
}

async function login(socket, assignedName, id = 'fleet:sendprobe') {
  await turn()
  const request = socket.sent.find(message => message.type === 'login')
  assert.ok(request)
  socket.reply(request, { ok: true, agent: { id, friendly_name: assignedName } })
  await turn()
  const subscription = socket.sent.find(message => message.type === 'subscribe-filter')
  if (subscription) {
    socket.reply(subscription, { ok: true })
    await turn()
  }
}

function makeBot(t, directory, { heartbeatFile = null } = {}) {
  pinEnv()
  t.after(restoreEnv)
  const transport = createTransportFixture()
  const logs = []
  const realLog = console.log
  console.log = (...args) => { logs.push(args.join(' ')) }
  t.after(() => { console.log = realLog })
  const bot = createBot({
    name: 'sendprobe',
    fleetId: 'fleet:sendprobe',
    pidFile: join(directory, 'sendprobe.pid'),
    server: 'http://fixture.test',
    WebSocketClass: transport.WebSocketClass,
    reconnectInitialMs: 1,
    reconnectMaxMs: 1,
    heartbeatFile,
  }).start()
  t.after(() => bot.stop())
  return { bot, transport, logs }
}

const heartbeatLines = file =>
  readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))

test('a dropped send writes one down edge, recovery writes one up edge', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'send-state-'))
  const heartbeatFile = join(directory, 'probe.heartbeat')
  writeFileSync(heartbeatFile, JSON.stringify({ ts: Date.now(), reason: 'tick' }) + '\n')
  const { bot, transport, logs } = makeBot(t, directory, { heartbeatFile })
  await login(transport.sockets[0], 'sendprobe')
  assert.equal(bot.canonical, true)

  bot.chat('fleet:x', 'while up')
  transport.sockets[0].close()
  bot.chat('fleet:x', 'first while down')
  bot.chat('fleet:x', 'second while down')
  await sleep(50) // reconnect window: the fixture reopens on a 1ms timer
  assert.ok(transport.sockets.length > 1, 'expected the socket to reconnect')
  bot.chat('fleet:x', 'after recovery')

  const lines = heartbeatLines(heartbeatFile)
  assert.deepEqual(lines.map(line => line.reason), ['tick', 'send-down', 'send-up'])
  assert.equal(lines[1].sendUp, false)
  assert.equal(lines[2].sendUp, true)
  assert.ok(logs.some(line => line.includes('send path down')))
  assert.ok(logs.some(line => line.includes('send path recovered')))
})

test('edges ride an existing heartbeat file and never create one', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'send-state-'))
  const heartbeatFile = join(directory, 'missing.heartbeat')
  const { bot, transport, logs } = makeBot(t, directory, { heartbeatFile })
  await login(transport.sockets[0], 'sendprobe')
  transport.sockets[0].close()
  bot.chat('fleet:x', 'dropped')
  assert.equal(existsSync(heartbeatFile), false)
  assert.ok(logs.some(line => line.includes('send path down')))
})

test('a non-canonical instance stays silent on the send path', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'send-state-'))
  const heartbeatFile = join(directory, 'probe.heartbeat')
  writeFileSync(heartbeatFile, JSON.stringify({ ts: Date.now(), reason: 'tick' }) + '\n')
  const { bot, transport, logs } = makeBot(t, directory, { heartbeatFile })
  await login(transport.sockets[0], 'somebody-else')
  assert.equal(bot.canonical, false)
  transport.sockets[0].close()
  bot.chat('fleet:x', 'dropped')
  assert.deepEqual(heartbeatLines(heartbeatFile).map(line => line.reason), ['tick'])
  assert.equal(logs.some(line => line.includes('send path down')), false)
})
