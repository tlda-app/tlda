#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listedSessionFiles } from './fleet-owner-harvester.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-owner-harvester-targeted-'))
try {
  const claudePath = path.join(dir, 'fresh-session.jsonl')
  fs.writeFileSync(claudePath, '{"type":"mode"}\n')

  assert.deepEqual(listedSessionFiles([path.join(dir, 'not-jsonl.txt')]), [])
  assert.deepEqual(listedSessionFiles([path.join(dir, 'missing.jsonl')]), [])
  assert.deepEqual(listedSessionFiles([claudePath]).map(item => ({
    sessionId: item.sessionId,
    filePath: item.filePath,
    harnessKind: item.harnessKind,
  })), [{
    sessionId: 'fresh-session',
    filePath: claudePath,
    harnessKind: 'claude',
  }])

  console.log('owner-harvester-targeted-test: ok')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
