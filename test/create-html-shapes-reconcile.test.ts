import assert from 'node:assert/strict'
import test from 'node:test'
import type { TLAssetId, TLPageId, TLShapeId } from 'tldraw'

import { createHtmlShapes } from '../src/loaders/createShapes'
import type { SvgDocument } from '../src/loaders/types'

type ShapeRecord = {
  id: string
  typeName: 'shape'
  type: string
  parentId?: string
  x: number
  y: number
  props: Record<string, unknown>
  [key: string]: unknown
}

type FakeEditor = Parameters<typeof createHtmlShapes>[0] & {
  records: Map<string, ShapeRecord>
}

const htmlShapeId = (name: string, index: number) => `shape:${name}-page-${index}` as TLShapeId

function makeDocument(files: string[]): SvgDocument {
  return {
    name: 'world-md',
    basePath: '/docs/world-md/',
    format: 'markdown',
    pages: files.map((file, index) => ({
      src: `/docs/world-md/${file}`,
      bounds: { x: index * 824, y: 0, w: 800, h: 1200, width: 800, height: 1200 },
      assetId: `asset:world-md-page-${index}` as TLAssetId,
      shapeId: htmlShapeId('world-md', index),
      width: 800,
      height: 1200,
      tldrawPageId: 'page:world-md-ch-0',
      tldrawPageName: 'world-md-world',
    })),
  }
}

function makeEditor(): FakeEditor {
  const records = new Map<string, ShapeRecord>()
  const pages = [{ id: 'page:page', name: 'Page 1' }]
  let currentPageId = 'page:page'

  return {
    records,
    store: {
      allRecords: () => Array.from(records.values()),
      put: (items: ShapeRecord[]) => {
        for (const item of items) records.set(item.id, item)
      },
    },
    getPages: () => pages,
    getCurrentPageId: () => currentPageId,
    setCurrentPage: (id: string) => { currentPageId = id },
    renamePage: (id: string, name: string) => {
      const page = pages.find(p => p.id === id)
      if (page) page.name = name
    },
    createPage: (page: { id: TLPageId; name: string }) => {
      pages.push(page)
    },
    getCurrentPageShapes: () => Array.from(records.values()).filter(record => record.typeName === 'shape' && (record.parentId || 'page:page') === currentPageId),
    getShape: (id: string) => records.get(id),
    createShapes: (shapes: ShapeRecord[]) => {
      for (const shape of shapes) {
        records.set(shape.id, {
          typeName: 'shape',
          rotation: 0,
          index: 'a1',
          opacity: 1,
          meta: {},
          ...shape,
        })
      }
    },
    deleteShapes: (ids: string[]) => {
      for (const id of ids) records.delete(id)
    },
    reparentShapes: (ids: string[], parentId: string) => {
      for (const id of ids) {
        const record = records.get(id)
        if (record) records.set(id, { ...record, parentId })
      }
    },
    sendToBack: () => {},
  } as unknown as FakeEditor
}

test('createHtmlShapes reconciles added and removed same-canvas markdown columns', () => {
  const editor = makeEditor()
  const initial = makeDocument(['index.html'])

  assert.equal(createHtmlShapes(editor, initial), false)
  assert.ok(editor.records.has(htmlShapeId('world-md', 0)))

  editor.records.set('shape:note-1', {
    id: 'shape:note-1',
    typeName: 'shape',
    type: 'note',
    parentId: 'page:page',
    x: 120,
    y: 80,
    props: {},
  })

  const expanded = makeDocument(['index.html', 'parts/77777777.html'])

  assert.equal(createHtmlShapes(editor, expanded), false)
  assert.ok(editor.records.has(htmlShapeId('world-md', 0)))
  assert.ok(editor.records.has(htmlShapeId('world-md', 1)))
  assert.ok(editor.records.has('shape:note-1'))
  assert.equal(editor.records.get(htmlShapeId('world-md', 1)).props.url, '/docs/world-md/parts/77777777.html')

  const contracted = makeDocument(['index.html'])

  assert.equal(createHtmlShapes(editor, contracted), false)
  assert.ok(editor.records.has(htmlShapeId('world-md', 0)))
  assert.equal(editor.records.has(htmlShapeId('world-md', 1)), false)
  assert.ok(editor.records.has('shape:note-1'))
  assert.equal(contracted.pages[0].bounds.x, 0)
  assert.equal(contracted.pages[0].bounds.w, 800)
})
