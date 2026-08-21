import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgentStatus } from '../daemon/agent-status.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('server roster messages never start local terminal inspection', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'bin/fleet-daemon.mjs'), 'utf8')
  const starts = [...source.matchAll(/agentStatus\.start\(\)/g)]
  assert.equal(starts.length, 1)
  const messageHandler = source.indexOf('function handleServerMessage(msg')
  const lifecycle = source.indexOf('// ---------- lifecycle ----------')
  const connect = source.lastIndexOf('\nconnect()')
  assert.ok(messageHandler >= 0)
  assert.ok(lifecycle > messageHandler)
  assert.ok(connect > lifecycle)
  assert.ok(starts[0].index > lifecycle && starts[0].index < connect)
  assert.doesNotMatch(source.slice(messageHandler, lifecycle), /agentStatus\.start\(\)/)
})

test('agent status start does not cold-scan the full roster', async () => {
  let captureCalls = 0
  const intervals = []
  const agentStatus = createAgentStatus({
    getAgents: () => [{
      id: 'fleet:singleflight',
      tmux_session: 'fleet-singleflight',
      dead: false,
      human: false,
      hibernating: false,
      metadata: {},
    }],
    harnessForAgent: () => ({ kind: 'codex' }),
    isConnected: () => true,
    sendMsg: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    capturePane: async () => {
      captureCalls += 1
      return { stdout: '' }
    },
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  agentStatus.start()
  agentStatus.start()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(captureCalls, 0)
  assert.equal(intervals.length, 1)
})

test('agent status scans an explicitly armed agent without overlapping', async () => {
  let captureCalls = 0
  let releaseCapture
  const firstCapture = new Promise(resolve => {
    releaseCapture = () => resolve({ stdout: '' })
  })
  const intervals = []
  const agentStatus = createAgentStatus({
    getAgents: () => [{
      id: 'fleet:singleflight',
      tmux_session: 'fleet-singleflight',
      dead: false,
      human: false,
      hibernating: false,
      metadata: {},
    }],
    harnessForAgent: () => ({ kind: 'codex' }),
    isConnected: () => true,
    sendMsg: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    capturePane: async () => {
      captureCalls += 1
      return firstCapture
    },
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  agentStatus.start()
  agentStatus.armAgent('fleet:singleflight')
  void agentStatus.scanArmedStatus()
  void agentStatus.scanArmedStatus()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(captureCalls, 1)
  assert.equal(intervals.length, 1)

  releaseCapture()
  await new Promise(resolve => setImmediate(resolve))
})

test('agent status disarms idle agents and repeated start does not rearm all', async () => {
  const intervals = []
  const agentStatus = createAgentStatus({
    getAgents: () => [{
      id: 'fleet:idle',
      tmux_session: 'fleet-idle',
      dead: false,
      human: false,
      hibernating: false,
      metadata: {},
    }],
    harnessForAgent: () => ({ kind: 'codex' }),
    isConnected: () => true,
    sendMsg: () => true,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    capturePane: async () => ({ stdout: '' }),
    statusLingerMs: -1,
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  agentStatus.start()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(agentStatus.isArmed('fleet:idle'), false)

  agentStatus.start()
  assert.equal(agentStatus.isArmed('fleet:idle'), false)
  assert.equal(intervals.length, 1)
})
