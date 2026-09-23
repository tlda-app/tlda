import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import {
  uuid7,
  serveStateDir,
  servePaneCommand,
  createMspChannel,
} from './muse-serve-host.mjs'
import {
  mspSend,
  mspSteer,
  mspCancel,
  mspDecideApproval,
  mspAnswerUserInput,
  mspReadOutput,
} from './muse-serve-ops.mjs'

test('uuid7 emits real version-7 ids that sort by time', () => {
  const a = uuid7()
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(a, uuid7())
})

test('serve state dir is namespaced per tmux session', () => {
  const a = serveStateDir('fleet-x', { tmpdir: '/tmp' })
  const b = serveStateDir('fleet-y', { tmpdir: '/tmp' })
  assert.ok(a.includes('fleet-x') && !a.includes('fleet-y'))
  assert.notEqual(a, b)
})

test('serve pane command runs the bridge with no fifos and secrets out of argv', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'muse-serve-cmd-'))
  const cmd = servePaneCommand({
    stateDir: dir,
    serveArgs: ['--disable-sandbox'],
    envAssignments: { XDG_CONFIG_HOME: '/tmp/cfg', FLEET_ID: 'fleet:x' },
  })
  assert.ok(cmd.includes('muse-serve-bridge.mjs'))
  assert.ok(cmd.includes('--state-dir'))
  assert.ok(cmd.includes('--disable-sandbox'))
  assert.ok(!cmd.includes('serve.stdin') && !cmd.includes('serve.stdout'))
  assert.ok(!cmd.includes('META_API_KEY'))
  rmSync(dir, { recursive: true, force: true })
})

test('serve pane command refuses to run without a state dir', () => {
  assert.throws(() => servePaneCommand({}), /state dir/)
})

function fakeInput() {
  const emitter = new EventEmitter()
  emitter.write = () => true
  return emitter
}

test('channel routes acks to the waiting send and notifications to onEvent', async () => {
  const input = fakeInput()
  const seen = []
  const channel = createMspChannel({ input, onEvent: msg => seen.push(msg), commandTimeoutMs: 1000 })
  const pending = channel.send('turn/start', { commandId: uuid7(), sessionId: 's' })
  input.emit('data', '{"jsonrpc":"2.0","method":"turn/started","params":{"turnId":"t"}}\n')
  input.emit('data', '{"jsonrpc":"2.0","id":1,"result":{"turnId":"t","status":"accepted"}}\n')
  const { result } = await pending
  assert.equal(result.turnId, 't')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].method, 'turn/started')
  channel.close()
})

test('channel surfaces server errors with code, not silence', async () => {
  const input = fakeInput()
  const channel = createMspChannel({ input, commandTimeoutMs: 1000 })
  const pending = channel.send('approval/decide', { commandId: uuid7() })
  input.emit('data', '{"jsonrpc":"2.0","id":1,"error":{"code":-32051,"message":"already resolved"}}\n')
  await assert.rejects(pending, /already resolved/)
  channel.close()
})

test('ops mint commandIds and pass caller ids through untouched', async () => {
  const calls = []
  const channel = {
    async send(method, params) {
      calls.push([method, params])
      return { result: { ok: true } }
    },
  }
  await mspSend(channel, { sessionId: 's', text: 'hi' })
  assert.equal(calls[0][0], 'turn/start')
  assert.match(calls[0][1].commandId, /-7[0-9a-f]{3}-/)
  assert.deepEqual(calls[0][1].input, [{ type: 'text', text: 'hi' }])
  await mspSteer(channel, { sessionId: 's', expectedTurnId: 't', text: 'no, this' })
  assert.equal(calls[1][0], 'turn/steer')
  assert.equal(calls[1][1].expectedTurnId, 't')
  await mspCancel(channel, { sessionId: 's', turnId: 't' })
  assert.equal(calls[2][1].turnId, 't')
  await mspDecideApproval(channel, { sessionId: 's', approvalId: 'a', choiceId: 'allow_once', requirementId: { approvalId: 'a', sourceIndex: 0 } })
  assert.equal(calls[3][1].choiceId, 'allow_once')
  await mspAnswerUserInput(channel, { sessionId: 's', userInputId: 'u', answers: [{ questionId: 'q', selectedLabel: 'red' }] })
  assert.equal(calls[4][1].userInputId, 'u')
  await mspReadOutput(channel, { sessionId: 's', itemId: 'i', outputRef: { id: 'p' } })
  assert.equal(calls[5][0], 'item/readOutput')
})

test('ops refuse to send without the ids the protocol needs', async () => {
  const channel = { async send() { throw new Error('must not send') } }
  await assert.rejects(mspSend(channel, { text: 'hi' }), /sessionId/)
  await assert.rejects(mspSteer(channel, { sessionId: 's', text: 'x' }), /expectedTurnId/)
  await assert.rejects(mspCancel(channel, {}), /sessionId/)
  await assert.rejects(mspDecideApproval(channel, { sessionId: 's' }), /approvalId/)
  await assert.rejects(mspAnswerUserInput(channel, { sessionId: 's' }), /userInputId/)
  await assert.rejects(mspReadOutput(channel, { sessionId: 's' }), /outputRef/)
})
