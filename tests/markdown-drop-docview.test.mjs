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
    /createMarkdownDocviewFromContent\(editor, pagePoint, title, markdown,[\s\S]*\}, url\)/,
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
    /createFleetShape\(editor, 'fleet-docview', pagePoint\.x, pagePoint\.y, \{/,
    'Markdown opens as a fleet doc-view panel, not only as an html-page column',
  )
})

test('dropped Markdown chips resolve through the shared click-path chain', () => {
  // A chip outside a code block carries no source template, so its content IS
  // the path and the drop must resolve it. That used to fetch a removed local
  // route and throw into a fire-and-forget promise: no document, no error.
  const fromPill = pill.slice(
    pill.indexOf('async function createMarkdownDocviewShapeFromPill'),
    pill.indexOf('export async function createMarkdownDocviewFromContent'),
  )
  assert.ok(fromPill.length > 0, 'createMarkdownDocviewShapeFromPill must precede createMarkdownDocviewFromContent')
  assert.match(
    fromPill,
    /fetchChatMarkdown\(fileUrl \|\| '', filePath \|\| '', sourceAgent \|\| ''\)/,
    'the pill drop must resolve Markdown through the same chain as clicking the chip',
  )
  assert.doesNotMatch(
    fromPill,
    /api\/read-file/,
    'the Markdown drop must not fetch the removed local-files route',
  )
  assert.match(
    fromPill,
    /CHIP_OPEN_FAILED/,
    'a chip the drop cannot load must surface the shared chip failure sentence',
  )
})

test('the doc view is placed the way a dropped label places a chat', () => {
  // Skip, 2026-09-18: "place it like the fking label drop places the chat".
  // The label drop creates its panel at the gesture's page point and stops;
  // the Markdown drop used to project that page point to screen and un-project
  // it again through whichever viewport the frame named, which is the identity
  // only while the HUD is closed.
  const labelDrop = pill.match(
    /createFleetShape\(createEditor, 'fleet-chat', createPagePoint\.x, createPagePoint\.y, \{/,
  )
  assert.ok(labelDrop, 'the label drop must still create its chat at the drop page point')

  const docview = pill.slice(
    pill.indexOf('export async function createMarkdownDocviewFromContent'),
    pill.indexOf('export async function createTemporaryMarkdownColumn'),
  )
  assert.ok(docview.length > 0, 'createMarkdownDocviewFromContent must precede createTemporaryMarkdownColumn')
  assert.doesNotMatch(
    docview,
    /pagePointToClient|placeFleetShapeAtScreenPoint/,
    'the Markdown doc view must not round-trip its page point through screen coordinates',
  )
})
