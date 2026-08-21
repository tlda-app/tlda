import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildErrorReferenceFromPosition,
  updateReferenceDocviews,
} from '../shared/docview-reference.mjs'

test('a build-error location becomes the same bounded reference consumed by ref docviews', () => {
  assert.deepEqual(
    buildErrorReferenceFromPosition(
      { file: 'chapter.tex', line: 20, message: 'Undefined control sequence' },
      { page: 2, y: 210 },
      { viewboxOffset: 72, pageHeight: 792 },
    ),
    {
      label: '',
      page: 2,
      yTop: 242,
      yBottom: 322,
      title: 'chapter.tex:20',
    },
  )
  assert.equal(buildErrorReferenceFromPosition(
    { file: 'missing.tex', line: 20, message: 'bad' },
    null,
    { viewboxOffset: 72, pageHeight: 792 },
  ), null)
})

test('reference updates reach only docviews subscribed to ref and preserve their other props', () => {
  const updates = []
  const editor = {
    getCurrentPageShapes: () => [
      { id: 'shape:ref', type: 'fleet-docview', isLocked: true, props: { sources: '["ref"]', w: 300 } },
      { id: 'shape:errors', type: 'fleet-docview', props: { sources: '["errors"]', w: 301 } },
      { id: 'shape:chat', type: 'fleet-chat', props: {} },
    ],
    updateShape: update => updates.push(update),
  }
  const count = updateReferenceDocviews(editor, { label: '', page: 2, yTop: 242, yBottom: 322, title: 'chapter.tex:20' })
  assert.equal(count, 1)
  assert.deepEqual(updates, [
    { id: 'shape:ref', type: 'fleet-docview', isLocked: false },
    {
      id: 'shape:ref', type: 'fleet-docview',
      props: { sources: '["ref"]', w: 300, label: '', page: 2, yTop: 242, yBottom: 322, title: 'chapter.tex:20' },
    },
  ])
})

test('bottom-right build-error click only retargets ref docviews and does not open an editor', () => {
  const source = readFileSync(new URL('../src/pills/BuildErrorPill.tsx', import.meta.url), 'utf8')
  assert.match(source, /showBuildErrorInReferenceDocviews\(editor, doc\.projectName, err\)/)
  assert.doesNotMatch(source, /openInEditor/)
  assert.doesNotMatch(source, /createShape|fleet-source-editor|source-editor/)
})
