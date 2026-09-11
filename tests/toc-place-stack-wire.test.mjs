import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/panels/TocTab.tsx', import.meta.url), 'utf8')

test('a TOC document move records the page being left', () => {
  const handler = source.match(/const handleHtmlNav[\s\S]*?\n  }, \[editor, doc\]\)/)?.[0] || ''
  assert.match(handler, /recordPlaceDeparture\(editor\)[\s\S]*navigateTo(?:Anchor|Page)\(editor, doc/)
})
