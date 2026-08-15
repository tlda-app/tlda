import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const handler = readFileSync(new URL('../src/MarkdownDropHandler.tsx', import.meta.url), 'utf8')
const pill = readFileSync(new URL('../src/shapes/FleetPillShape.tsx', import.meta.url), 'utf8')

test('native Markdown file drops enter the bounded doc-view path', () => {
  assert.match(
    handler,
    /materializeMarkdownChip\(\{ markdown, title, sourcePath: file\.name \}\)/,
    'native Markdown file drops must materialize into the current project',
  )
  assert.match(
    handler,
    /createMarkdownDocviewFromContent\(editor, pagePoint, title, markdown,[\s\S]*url, screenPoint\)/,
    'native Markdown file drops must create the same HUD doc view as Markdown chips',
  )
  assert.doesNotMatch(
    handler,
    /Markdown drop ignored/,
    'the generic Markdown drop handler must not swallow drops as disabled inline-docs',
  )
})

test('Markdown doc-view creation is shared with the Markdown chip path', () => {
  assert.match(
    pill,
    /export async function createMarkdownDocviewFromContent/,
    'the bounded Markdown doc-view path must be reusable outside pill drops',
  )
  assert.match(
    pill,
    /placeFleetShapeAtScreenPoint\(editor, 'fleet-docview', docviewScreenPoint\.x, docviewScreenPoint\.y, MARKDOWN_DOCVIEW_W, MARKDOWN_DOCVIEW_H/,
    'Markdown opens as a fleet doc-view panel, not only as an html-page column',
  )
})
