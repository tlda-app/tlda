import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentStatus } from './agent-status.mjs'
import { createEvidenceAdmission } from './agent-evidence.mjs'

function scanner({ panes }) {
  const sent = []
  const agents = [{ id: 'fleet:a', tmux_session: 'fleet-a', sessionKind: 'claude' }]
  const status = createAgentStatus({
    tmuxArgs: [],
    sendMsg: msg => sent.push(msg),
    log: { info() {} },
    getAgents: () => agents,
    getAdmit: () => admit,
    harnessForAgent: () => ({ kind: 'claude' }),
    isConnected: () => true,
    statusScanMs: 1000,
    setIntervalFn: () => ({ unref() {} }),
    capturePane: async () => ({ stdout: panes.shift() || '' }),
  })
  const admit = createEvidenceAdmission({ activity: status, log: { info() {}, warn() {} } })
  return { status, admit, sent }
}

const TRANSCRIPT_THINKING = {
  agentId: 'fleet:a', source: 'transcript', atMs: Date.now(), activity: 'thinking',
}
const TRANSCRIPT_IDLE = {
  agentId: 'fleet:a', source: 'transcript', atMs: Date.now(), activity: 'idle',
}
const PANE_UNKNOWN = {
  agentId: 'fleet:a', source: 'pane-scrape', atMs: Date.now(), activity: 'unknown',
}

test('sustained text generation is working when the pane still shows a spinner', async () => {
  const { status, sent } = scanner({
    panes: ['draft text streaming\nWorking…\nesc to interrupt'],
  })

  status.armAgent('fleet:a')
  await status.scanStatus()

  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'agent-status')
  assert.equal(sent[0].agent_id, 'fleet:a')
  assert.equal(sent[0].activity, 'thinking')
})

test('finished prompt becomes idle only after the quiet pane is confirmed', async () => {
  const { status, sent } = scanner({
    panes: [
      'Working…\nEsc to interrupt',
      'done\n❯ ',
      'done\n❯ ',
    ],
  })

  status.armAgent('fleet:a')
  await status.scanStatus()
  await status.scanStatus()
  await status.scanStatus()

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking', 'idle'])
})

test('an open transcript turn holds pane idle across scans', async () => {
  const { status, admit, sent } = scanner({ panes: ['done\n❯ ', 'done\n❯ ', 'done\n❯ '] })

  admit({ ...TRANSCRIPT_THINKING })
  status.armAgent('fleet:a')
  await status.scanStatus()
  await status.scanStatus()
  await status.scanStatus()

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking'])
})

test('transcript turn-close releases the hold; the next pane idle resolves', async () => {
  const { status, admit, sent } = scanner({ panes: ['done\n❯ ', 'done\n❯ '] })

  admit({ ...TRANSCRIPT_THINKING })
  status.armAgent('fleet:a')
  await status.scanStatus()
  admit({ ...TRANSCRIPT_IDLE })
  await status.scanStatus()

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking', 'idle'])
})

test('a second turn-open supersedes without closing the turn', async () => {
  const { status, admit, sent } = scanner({ panes: ['done\n❯ ', 'done\n❯ ', 'done\n❯ '] })

  admit({ ...TRANSCRIPT_THINKING })
  status.armAgent('fleet:a')
  await status.scanStatus()
  admit({ ...TRANSCRIPT_THINKING })
  await status.scanStatus()
  await status.scanStatus()

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking'])
})

test('pane unknown is held while a turn is open', () => {
  const { admit, sent } = scanner({ panes: [] })

  admit({ ...TRANSCRIPT_THINKING })
  admit({ ...PANE_UNKNOWN })
  admit({ ...PANE_UNKNOWN })

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking'])
})

test('closeTurn releases the hold without voting', async () => {
  const { status, admit, sent } = scanner({ panes: ['done\n❯ ', 'done\n❯ ', 'done\n❯ '] })

  admit({ ...TRANSCRIPT_THINKING })
  status.armAgent('fleet:a')
  await status.scanStatus()
  assert.deepEqual(sent.map(msg => msg.activity), ['thinking'])
  status.closeTurn('fleet:a')
  assert.deepEqual(sent.map(msg => msg.activity), ['thinking'])
  await status.scanStatus()
  await status.scanStatus()

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking', 'idle'])
})

test('non-transcript thinking does not open a turn', async () => {
  const { status, admit, sent } = scanner({ panes: ['done\n❯ ', 'done\n❯ '] })

  admit({ agentId: 'fleet:a', source: 'hook', atMs: Date.now(), activity: 'thinking' })
  status.armAgent('fleet:a')
  await status.scanStatus()
  await status.scanStatus()

  assert.deepEqual(sent.map(msg => msg.activity), ['thinking', 'idle'])
})
