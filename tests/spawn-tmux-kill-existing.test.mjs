import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnTmux } from '../agent-launch/tmux.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-spawn-tmux-'))
const bin = path.join(dir, 'bin')
const log = path.join(dir, 'tmux-args.log')
const oldPath = process.env.PATH

fs.mkdirSync(bin)
fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
printf '%s\\n' "$*" >> "$TLDA_FAKE_TMUX_LOG"
exit 0
`, { mode: 0o755 })

try {
  process.env.PATH = `${bin}:${oldPath}`
  process.env.TLDA_FAKE_TMUX_LOG = log

  await spawnTmux('fleet-plain', dir, 'echo plain', { autoDismiss: false })
  await spawnTmux('fleet-replace', dir, 'echo replace', { autoDismiss: false, killExisting: true })

  const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
  const plain = lines.find(line => line.includes('respawn-pane') && line.includes('fleet-plain'))
  const replace = lines.find(line => line.includes('respawn-pane') && line.includes('fleet-replace'))

  assert.ok(plain, 'plain spawn should call respawn-pane')
  assert.ok(replace, 'replacement spawn should call respawn-pane')
  assert.equal(plain.includes(' -k '), false, 'plain spawn must not kill an existing runtime')
  assert.equal(replace.includes(' -k '), true, 'replacement spawn must kill the existing pane')
} finally {
  process.env.PATH = oldPath
  delete process.env.TLDA_FAKE_TMUX_LOG
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('spawn tmux kill-existing option ok')
