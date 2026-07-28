#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { spawnTmux, uniqueSessionName } from '../agent-launch/tmux.mjs'

const suffix = `${process.pid}-${Date.now()}`
const base = `tlda-exact-${suffix}`
const sibling = `${base}-assistant`
const exiting = `tlda-exit-${suffix}`

function hasSession(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', `=${name}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function killSession(name) {
  if (hasSession(name)) {
    execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' })
  }
}

try {
  execFileSync('tmux', ['new-session', '-d', '-s', sibling])
  assert.equal(await uniqueSessionName(base), base)

  await spawnTmux(exiting, os.tmpdir(), 'TLDA_LIFECYCLE_PROBE=1 sh -c "exit 0"', {
    autoDismiss: false,
    sendKeys: true,
  })

  const deadline = Date.now() + 5000
  while (hasSession(exiting) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(hasSession(exiting), false)
  console.log('tmux exact targeting and lifecycle regression: ok')
} finally {
  killSession(base)
  killSession(sibling)
  killSession(exiting)
}
