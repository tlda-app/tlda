import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import test from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyPlaywrightProcessLine } from '../cli/lib/pw.mjs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const TLDA_DEV = join(ROOT, 'cli', 'tlda-dev.mjs')

test('classifies canonical playwright daemon and browser processes', () => {
  assert.deepEqual(
    classifyPlaywrightProcessLine('123 1 /opt/node /repo/node_modules/playwright-core/lib/entry/cliDaemon.js shared --headed --browser=chromium', 'shared'),
    { kind: 'daemon', pid: 123, ppid: 1, command: '/opt/node /repo/node_modules/playwright-core/lib/entry/cliDaemon.js shared --headed --browser=chromium' },
  )
  assert.deepEqual(
    classifyPlaywrightProcessLine('124 123 /Cache/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/ud-shared-chrome-for-testing about:blank', 'shared'),
    { kind: 'browser', pid: 124, ppid: 123, command: '/Cache/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/ud-shared-chrome-for-testing about:blank' },
  )
  assert.equal(
    classifyPlaywrightProcessLine('125 124 /Cache/Google Chrome Helper --type=renderer --user-data-dir=/tmp/ud-shared-chrome-for-testing', 'shared'),
    null,
  )
  assert.equal(
    classifyPlaywrightProcessLine('126 1 /opt/node cliDaemon.js other --headed --browser=chromium', 'shared'),
    null,
  )
  assert.equal(
    classifyPlaywrightProcessLine('127 1 /bin/zsh -lc ps | grep -E "cliDaemon.js shared|ud-shared-chrome"', 'shared'),
    null,
  )
})

test('refuses ad-hoc persistent sessions unless explicitly isolated', () => {
  try {
    execFileSync(process.execPath, [TLDA_DEV, 'pw', 'acquire'], {
      encoding: 'utf8',
      env: { ...process.env, TLDA_PW_SESSION: 'rogue-session', TLDA_PW_ALLOW_ISOLATED_SESSION: '' },
      timeout: 5000,
    })
    assert.fail('expected non-canonical acquire to fail')
  } catch (e) {
    assert.notEqual(e.status, 0)
    assert.match(e.stderr || '', /refusing non-canonical playwright session "rogue-session"/)
  }
})
