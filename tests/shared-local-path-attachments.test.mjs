import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { detectAttachments } from '../shared/message-processing.mjs'

test('existing bare local path can remain readable without attachment materialization', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-shared-path-'))
  const file = path.join(dir, 'AGENTS.md')
  fs.writeFileSync(file, '# guidance\n')

  const result = detectAttachments(
    `Read ${file} before acting.`,
    dir,
    'https://fleet.example',
    { preserveBarePath: () => true },
  )

  assert.equal(result.resolvedMessage, `Read ${file} before acting.`)
  assert.deepEqual(result.inlineAttachments, [])
})

test('bare local path still becomes an attachment when not preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-cross-path-'))
  const file = path.join(dir, 'AGENTS.md')
  fs.writeFileSync(file, '# guidance\n')

  const result = detectAttachments(`Read ${file} before acting.`, dir, 'https://fleet.example')

  assert.equal(result.resolvedMessage, 'Read {{att:0}} before acting.')
  assert.equal(result.inlineAttachments.length, 1)
  assert.equal(result.inlineAttachments[0].path, file)
})

test('explicit markdown file links remain attachments even when bare paths are preserved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-explicit-link-'))
  const file = path.join(dir, 'AGENTS.md')
  fs.writeFileSync(file, '# guidance\n')

  const result = detectAttachments(
    `Read [guidance](${file}) before acting.`,
    dir,
    'https://fleet.example',
    { preserveBarePath: () => true },
  )

  assert.equal(result.resolvedMessage, 'Read {{att:0}} before acting.')
  assert.equal(result.inlineAttachments.length, 1)
  assert.equal(result.inlineAttachments[0].path, file)
})
