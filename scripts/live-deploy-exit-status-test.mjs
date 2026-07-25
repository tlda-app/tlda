#!/usr/bin/env node
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  bootProbePassed,
  buildProbeDiagnosticsCommand,
  buildBootProbeCommand,
  currentImageRefFromFlyImageShow,
  extractImageRef,
  flyAppNameFromConfig,
  parseMachineId,
  runCommand,
} from './live-deploy.mjs'

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

assert.equal(
  extractImageRef([
    'noise',
    'image: registry.fly.io/tldraw-sync-skip:deployment-01KYC4613BD6EVZ3K9QFYHAAN7',
  ]),
  'registry.fly.io/tldraw-sync-skip:deployment-01KYC4613BD6EVZ3K9QFYHAAN7',
)

assert.equal(
  currentImageRefFromFlyImageShow([
    '[{"Registry":"registry.fly.io","Repository":"tldraw-sync-skip","Tag":"deployment-01KYC4613BD6EVZ3K9QFYHAAN7"}]',
  ]),
  'registry.fly.io/tldraw-sync-skip:deployment-01KYC4613BD6EVZ3K9QFYHAAN7',
)

assert.equal(
  flyAppNameFromConfig('fly.live.toml', () => 'app = "tldraw-sync-skip"\n'),
  'tldraw-sync-skip',
)

assert.equal(
  parseMachineId(['[{"id":"68349d0f019298","name":"tlda-live-boot-probe"}]'], 'tlda-live-boot-probe'),
  '68349d0f019298',
)

assert.equal(
  parseMachineId(['Machine 68349d0f019298 has been created']),
  '68349d0f019298',
)

assert.equal(
  bootProbePassed([
    'node:internal/modules/run_main:107',
    'Exit code: 1',
  ], '3762a7d5a98957ae8fe1c17c06af2ee4a59a6041'),
  false,
)

assert.equal(
  bootProbePassed([
    '{"health":{"ok":true},"buildInfo":{"sha":"3762a7d5a98957ae8fe1c17c06af2ee4a59a6041","dirty":false},"fleetConfig":{"name":"testing"}}',
    'Exit code: 0',
  ], '3762a7d5a98957ae8fe1c17c06af2ee4a59a6041'),
  true,
)

{
  const command = buildBootProbeCommand('3762a7d5a98957ae8fe1c17c06af2ee4a59a6041')
  assert.match(command, /http:\/\/127\.0\.0\.1:5176\/health/)
  assert.match(command, /api\/build-info/)
  assert.match(command, /api\/fleet-config/)
  assert.match(command, /3762a7d5a98957ae8fe1c17c06af2ee4a59a6041/)
}

{
  const command = buildProbeDiagnosticsCommand()
  assert.match(command, /ps -eo/)
  assert.match(command, /node\*\|\*tailscale\*\|\*esbuild/)
}

console.log('live deploy boot-gate helper tests passed')
