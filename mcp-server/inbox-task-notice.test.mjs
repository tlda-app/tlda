// Task-notice inbox rows must carry the id that opens them. The server selects
// e.task_id into every inbox row, but the rendered line used to offer only
// `reply chat(to: …)` — a delegate/task notice for a task outside the reader's
// ACTIVE WORK blocks was a dead end with no openable reference.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'inbox-task-notice-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'inbox-task-notice-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: inbox-task-notice-test',
  '  values:',
  '    inbox-task-notice-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { resolveInboxMessage } = await import('./fleet-tools.mjs')

const resolvers = {
  resolveChipTokens: async text => ({ text, images: [] }),
  resolveTheoremRefs: text => text,
  resolveImages: async text => ({ text, images: [] }),
}

test('a delegate row carries its task id and names how to open it', async () => {
  const resolved = await resolveInboxMessage({
    id: 9001,
    type: 'delegate',
    from: 'fleet:delegator',
    text: 'go and do the thing',
    metadata: null,
    task_id: 'fleet:2b81-mujxvt14',
    timestamp: '2026-09-27T14:00:00.000Z',
  }, resolvers)

  assert.equal(resolved.kind, 'task')
  assert.equal(resolved.task_id, 'fleet:2b81-mujxvt14')
  assert.match(resolved.line, /open `thread\(\{ task_id: "fleet:2b81-mujxvt14" \}\)`/)
})

test('a task_done row names how to open it', async () => {
  const resolved = await resolveInboxMessage({
    id: 9002,
    type: 'task_done',
    from: 'fleet:worker',
    text: 'done: the thing',
    metadata: null,
    task_id: 'fleet:2b81-mujxvt14',
    timestamp: '2026-09-27T14:05:00.000Z',
  }, resolvers)

  assert.equal(resolved.task_id, 'fleet:2b81-mujxvt14')
  assert.match(resolved.line, /open `thread\(\{ task_id: "fleet:2b81-mujxvt14" \}\)`/)
})

test('a chat row without a task id renders no open hint', async () => {
  const resolved = await resolveInboxMessage({
    id: 9003,
    type: 'chat',
    from: 'fleet:skip',
    text: 'just a message',
    metadata: null,
    task_id: null,
    timestamp: '2026-09-27T14:00:00.000Z',
  }, resolvers)

  assert.equal(resolved.task_id, null)
  assert.equal(resolved.line.includes('open `thread('), false)
  assert.match(resolved.line, /reply `chat\(to: "fleet:skip"\)`/)
})
