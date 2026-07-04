import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const svgPageShape = readFileSync(new URL('../src/shapes/SvgPageShape.tsx', import.meta.url), 'utf8')
const viewerStateShape = readFileSync(new URL('../src/shapes/DocViewerStateShape.tsx', import.meta.url), 'utf8')
const svgDocument = readFileSync(new URL('../src/SvgDocument.tsx', import.meta.url), 'utf8')
const syncRooms = readFileSync(new URL('../server/lib/sync-rooms.mjs', import.meta.url), 'utf8')
const pageColumn = readFileSync(new URL('../src/hooks/usePageColumn.ts', import.meta.url), 'utf8')
const mcpServer = readFileSync(new URL('../mcp-server/index.mjs', import.meta.url), 'utf8')
const yjsSync = readFileSync(new URL('../src/useYjsSync.ts', import.meta.url), 'utf8')
const projectRoutes = readFileSync(new URL('../server/routes/projects.mjs', import.meta.url), 'utf8')

test('compare svg-page metadata is part of the synced shape schema', () => {
  for (const prop of ['compareRef', 'compareHash7']) {
    assert.match(svgPageShape, new RegExp(`${prop}: T\\.optional\\(T\\.string\\)`))
    assert.match(syncRooms, new RegExp(`${prop}: T\\.optional\\(T\\.string\\)`))
  }
  assert.match(pageColumn, /compareRef: this\.options\.source\.ref/)
  assert.match(pageColumn, /compareHash7: this\.options\.source\.ref\.slice\(0, 7\)/)
  assert.match(svgPageShape, /const propHash7 = shape\.props\.compareHash7 \|\| shape\.props\.compareRef\?\.slice\(0, 7\)/)
})

test('doc-viewer-state shape is registered on client and server with matching props', () => {
  assert.match(svgDocument, /DocViewerStateShapeUtil/)
  assert.match(syncRooms, /'doc-viewer-state':/)

  const props = [
    'timestamp',
    'diffReviewJson',
    'diffSummariesJson',
  ]
  for (const prop of props) {
    assert.match(viewerStateShape, new RegExp(`${prop}: T\\.`))
    assert.match(syncRooms, new RegExp(`${prop}: T\\.`))
  }
})

test('obsolete old-view and graph-draw signal paths stay deleted', () => {
  for (const source of [mcpServer, yjsSync, projectRoutes, svgDocument]) {
    assert.doesNotMatch(source, /doc_view/)
    assert.doesNotMatch(source, /signal:view-pin/)
    assert.doesNotMatch(source, /ViewPin/)
    assert.doesNotMatch(source, /graph-draw/)
    assert.doesNotMatch(source, /GraphDrawSignal/)
    assert.doesNotMatch(source, /onGraphDrawSignal/)
  }
})
