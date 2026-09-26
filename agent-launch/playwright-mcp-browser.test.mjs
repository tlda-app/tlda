import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  findChromeForTestingExecutable,
  playwrightBrowsersRoot,
  playwrightMcpBrowserArgs,
} from './playwright-mcp-browser.mjs'

const DARWIN_BIN = path.join(
  'chrome-mac-arm64',
  'Google Chrome for Testing.app',
  'Contents',
  'MacOS',
  'Google Chrome for Testing'
)

function stubBrowsers(t, layout) {
  const root = mkdtempSync(path.join(tmpdir(), 'pw-browsers-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [dir, withBinary] of Object.entries(layout)) {
    const full = path.join(root, dir)
    mkdirSync(full, { recursive: true })
    if (withBinary) {
      const bin = path.join(full, DARWIN_BIN)
      mkdirSync(path.dirname(bin), { recursive: true })
      writeFileSync(bin, '#!/bin/sh\n')
    }
  }
  return root
}

const DARWIN = { platform: 'darwin', arch: 'arm64', homedir: '/nonexistent-home' }

test('resolution picks the newest installed chromium with a binary', t => {
  const browsers = stubBrowsers(t, {
    'chromium-1232': true,
    'chromium-1234': true,
    webkit: false,
  })
  const found = findChromeForTestingExecutable({
    ...DARWIN,
    env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
  })
  assert.equal(found, path.join(browsers, 'chromium-1234', DARWIN_BIN))
})

test('resolution skips the headless shell and revisions without a binary', t => {
  const browsers = stubBrowsers(t, {
    chromium_headless_shell1234: false,
    'chromium_headless_shell-1234': false,
    'chromium-9999': false,
    'chromium-1232': true,
  })
  // A headless-shell binary must never be picked even when it exists.
  const shellBin = path.join(browsers, 'chromium_headless_shell-1234', DARWIN_BIN)
  mkdirSync(path.dirname(shellBin), { recursive: true })
  writeFileSync(shellBin, '#!/bin/sh\n')
  const found = findChromeForTestingExecutable({
    ...DARWIN,
    env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
  })
  assert.equal(found, path.join(browsers, 'chromium-1232', DARWIN_BIN))
})

test('resolution is null when no chromium binary exists', t => {
  const browsers = stubBrowsers(t, { 'chromium-1234': false, webkit: false })
  assert.equal(
    findChromeForTestingExecutable({ ...DARWIN, env: { PLAYWRIGHT_BROWSERS_PATH: browsers } }),
    null
  )
  assert.equal(
    findChromeForTestingExecutable({ ...DARWIN, env: { PLAYWRIGHT_BROWSERS_PATH: path.join(browsers, 'missing') } }),
    null
  )
})

test('the browsers root honors PLAYWRIGHT_BROWSERS_PATH and platform defaults', () => {
  assert.equal(
    playwrightBrowsersRoot({ env: { PLAYWRIGHT_BROWSERS_PATH: '/custom/root' }, platform: 'darwin', homedir: '/h' }),
    '/custom/root'
  )
  assert.equal(
    playwrightBrowsersRoot({ env: {}, platform: 'darwin', homedir: '/h' }),
    path.join('/h', 'Library', 'Caches', 'ms-playwright')
  )
  assert.equal(
    playwrightBrowsersRoot({ env: {}, platform: 'linux', homedir: '/h' }),
    path.join('/h', '.cache', 'ms-playwright')
  )
  assert.equal(
    playwrightBrowsersRoot({ env: { PLAYWRIGHT_BROWSERS_PATH: '0' }, platform: 'linux', homedir: '/h' }),
    path.join('/h', '.cache', 'ms-playwright')
  )
})

test('the MCP flag set names the bundled browser and the installed binary', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw-browsers-args-'))
  const browsers = path.join(dir, 'browsers')
  const bin = path.join(browsers, 'chromium-1234', DARWIN_BIN)
  mkdirSync(path.dirname(bin), { recursive: true })
  writeFileSync(bin, '#!/bin/sh\n')
  const args = playwrightMcpBrowserArgs({
    ...DARWIN,
    env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
  })
  try {
    assert.ok(args.includes('--browser') && args.includes('chromium'))
    assert.ok(args.includes('--isolated'))
    assert.ok(args.includes('--no-sandbox'))
    assert.ok(!args.includes('--headless'), 'headed always: headless screenshots can pass where no user would')
    const exeAt = args.indexOf('--executable-path')
    assert.notEqual(exeAt, -1)
    assert.equal(args[exeAt + 1], bin)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the MCP flag set without an installed binary keeps the channel and fails loud', t => {
  const browsers = mkdtempSync(path.join(tmpdir(), 'pw-browsers-empty-'))
  try {
    const args = playwrightMcpBrowserArgs({
      ...DARWIN,
      env: { PLAYWRIGHT_BROWSERS_PATH: browsers },
    })
    // --browser chromium stays: falling back to the default channel would
    // silently reproduce the original defect. The server then fails its first
    // tool call naming the missing revision and the install command.
    assert.ok(args.includes('--browser') && args.includes('chromium'))
    assert.ok(!args.includes('--executable-path'))
  } finally {
    rmSync(browsers, { recursive: true, force: true })
  }
})
