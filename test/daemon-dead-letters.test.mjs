import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import test from 'node:test'
import { persistDeadLetter, replayDeadLetters } from '../bin/lib/daemon/dead-letters.mjs'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-dead-letters-'))
  return path.join(dir, 'daemon-dead-letters.jsonl')
}

test('dead-letter replay drains sent critical messages', () => {
  const file = tempFile()
  persistDeadLetter(file, { type: 'terminal-dead', agent_id: 'fleet:a', tmux_session: 'fleet-a' }, { now: () => '2026-07-05T00:00:00.000Z' })
  persistDeadLetter(file, { type: 'spawn-startup-failed', agent_id: 'fleet:b', reason: 'boot failed' }, { now: () => '2026-07-05T00:00:01.000Z' })
  const sent = []
  const result = replayDeadLetters(file, (msg) => {
    sent.push(msg)
    return true
  })
  assert.deepEqual(result, { replayed: 2, remaining: 0, malformed: 0 })
  assert.equal(fs.existsSync(file), false)
  assert.deepEqual(sent.map(msg => msg.type), ['terminal-dead', 'spawn-startup-failed'])
  assert.equal(sent[0].agent_id, 'fleet:a')
  assert.equal(sent[1].agent_id, 'fleet:b')
})

test('dead-letter replay keeps unsent tail for the next reconnect', () => {
  const file = tempFile()
  persistDeadLetter(file, { type: 'terminal-dead', agent_id: 'fleet:a' }, { now: () => '2026-07-05T00:00:00.000Z' })
  persistDeadLetter(file, { type: 'terminal-dead', agent_id: 'fleet:b' }, { now: () => '2026-07-05T00:00:01.000Z' })
  persistDeadLetter(file, { type: 'terminal-dead', agent_id: 'fleet:c' }, { now: () => '2026-07-05T00:00:02.000Z' })
  const sent = []
  const result = replayDeadLetters(file, (msg) => {
    sent.push(msg.agent_id)
    return msg.agent_id !== 'fleet:b'
  })
  assert.deepEqual(result, { replayed: 1, remaining: 2, malformed: 0 })
  assert.deepEqual(sent, ['fleet:a', 'fleet:b'])
  const remaining = fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line).agent_id)
  assert.deepEqual(remaining, ['fleet:b', 'fleet:c'])
})
