import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createForkTransport } from './build-transport.mjs'

const fixture = fileURLToPath(new URL('./fixtures/build-process-tree-worker.mjs', import.meta.url))

function pgid(pid) {
  try { return Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim()) || null }
  catch { return null }
}

async function waitForGone(pids) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (pids.every(pid => pgid(pid) === null)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.deepEqual(pids.map(pid => pgid(pid)), pids.map(() => null))
}

test('transport cancellation terminates the worker and every descendant in its process group', async () => {
  const transport = createForkTransport(fixture)
  let resolveTree
  const tree = new Promise(resolve => { resolveTree = resolve })
  const exited = new Promise(resolve => {
    const handle = transport.start({ name: 'paper', osPriority: 10 }, {
      onMessage(message) { if (message?.t === 'tree') resolveTree({ message, handle }) },
      onError: assert.fail,
      onExit: resolve,
    })
  })
  const { message, handle } = await tree
  const pids = [message.worker, message.child, message.grandchild]
  const groups = pids.map(pgid)
  assert.ok(groups[0])
  assert.deepEqual(groups, [groups[0], groups[0], groups[0]])
  handle.cancel()
  await exited
  await waitForGone(pids)
})
