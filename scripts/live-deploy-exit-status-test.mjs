#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { runCommand } from './live-deploy.mjs'

function fakeSpawn({ code = 0, signal = null, stdout = [], stderr = [] } = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    queueMicrotask(() => {
      for (const chunk of stdout) child.stdout.emit('data', chunk)
      for (const chunk of stderr) child.stderr.emit('data', chunk)
      child.emit('close', code, signal)
    })
    return child
  }
}

{
  const writes = []
  const result = await runCommand('npm', ['run', 'build'], {
    tailLines: 2,
    stdio: [null, { write: chunk => writes.push(String(chunk)) }, { write: chunk => writes.push(String(chunk)) }],
    spawnFn: fakeSpawn({
      code: 17,
      stdout: ['line 1\nline 2\n'],
      stderr: ['line 3\n'],
    }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 17)
  assert.deepEqual(result.tail, ['line 2', 'line 3'])
  assert.deepEqual(writes, ['line 1\nline 2\n', 'line 3\n'])
}

{
  const result = await runCommand('npm', ['run', 'build'], {
    stdio: [null, { write() {} }, { write() {} }],
    spawnFn: fakeSpawn({ code: 0, stdout: ['ok\n'] }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.deepEqual(result.tail, ['ok'])
}

console.log('live deploy exit-status tests passed')
