import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveMarkdownSelectorBody } from '../mcp-server/lib/markdown-selector-body.mjs'

function fixtureFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-note-selector-'))
  const file = path.join(dir, 'source.md')
  fs.writeFileSync(file, `# Root

Intro.

## Keep Me {.note}

Selected body.

## Other

Other body.
`)
  return { dir, file }
}

test('note selector body resolves markdown and source provenance', () => {
  const { file } = fixtureFile()
  const result = resolveMarkdownSelectorBody({ file, selector: 'keep-me' })
  assert.equal(result.body, `## Keep Me {.note}

Selected body.`)
  assert.deepEqual(result.source, { file, selector: 'keep-me' })
})

test('note selector body rejects inline text plus file selector', () => {
  const { file } = fixtureFile()
  const result = resolveMarkdownSelectorBody({ text: 'inline', file, selector: '.note' })
  assert.equal(result.error, 'Provide either `text` or `file`+`selector`, not both.')
})

test('note selector body distinguishes file-only legacy form from missing selector', () => {
  const { file } = fixtureFile()
  assert.equal(resolveMarkdownSelectorBody({ file }).skipped, true)
  assert.match(resolveMarkdownSelectorBody({ file, selector: '.missing' }).error, /No markdown elements match CSS selector/)
})
