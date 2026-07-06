import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { spawnTmux } from '../bin/lib/spawn/tmux.mjs'

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

test('spawnTmux crashLogPath captures stderr from a fast-exiting launch', async (t) => {
  const tmuxCheck = await run('tmux', ['-V'])
  if (tmuxCheck.code !== 0) {
    t.skip(`tmux unavailable: ${tmuxCheck.stderr || tmuxCheck.stdout}`)
    return
  }

  const session = `tlda-crash-capture-${process.pid}-${Date.now()}`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-spawn-crash-'))
  const logPath = path.join(dir, 'spawn-crash.log')
  const sentinel = `FAST_CRASH_SENTINEL_${process.pid}_${Date.now()}`
  try {
    await spawnTmux(
      session,
      process.cwd(),
      `printf '${sentinel}\\n' >&2; exit 73`,
      { autoDismiss: false, crashLogPath: logPath, tmuxSocket: null }
    )
    await new Promise(resolve => setTimeout(resolve, 500))

    const text = fs.readFileSync(logPath, 'utf8')
    assert.match(text, new RegExp(sentinel))
    assert.match(text, /=== spawn .* session=tlda-crash-capture-/)
  } finally {
    await run('tmux', ['kill-session', '-t', session]).catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
