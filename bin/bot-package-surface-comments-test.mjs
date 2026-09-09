#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const scanner = fileURLToPath(new URL('./bot-package-surface-test.mjs', import.meta.url))

function runScanner(files) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-bot-surface-'))
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const path = join(root, relativePath)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, source)
    }
    return spawnSync(process.execPath, [scanner], {
      encoding: 'utf8',
      env: { ...process.env, TLDA_BOTS_ROOT: root },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('comment examples are ignored while real named imports are detected', () => {
  const result = runScanner({
    'bot.mjs': "import {\n  runBot as startBot,\n} from '@tlda/bot'\n",
    'current-mint-launch-failure/bin/copied-scanner.mjs': "// Both `import { a } from '@tlda/bot'` and a multi-line brace block.\n",
    'partial-mint-transaction/bin/copied-scanner.mjs': "/* import { a } from '@tlda/bot' */\n",
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /ok \(1 symbols across 1 bot files\)/)
})

test('a real missing named import still fails the scanner', () => {
  const result = runScanner({
    'bot.mjs': "import { definitelyMissingFromBotPackage } from '@tlda/bot'\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /MISSING 'definitelyMissingFromBotPackage'/)
})
