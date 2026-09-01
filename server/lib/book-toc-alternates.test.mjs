import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { aggregateBookToc, setProjectPathOverride } from './project-store.mjs'

test('book toc keeps a slides alternate under the existing chapter member', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-book-alternate-'))
  const book = join(root, 'course')
  const member = join(root, 'sampling')
  try {
    mkdirSync(join(book, 'output'), { recursive: true })
    mkdirSync(join(member, 'output'), { recursive: true })
    writeFileSync(join(member, 'output', 'toc.json'), JSON.stringify([
      { title: 'Sampling', level: 'section', page: 1 },
      { title: 'Slides', level: 'section', page: 1, variant: 'slides' },
    ]))
    setProjectPathOverride('course-alternate-test', book)
    setProjectPathOverride('sampling-alternate-test', member)

    aggregateBookToc('course-alternate-test', ['sampling-alternate-test'])

    assert.deepEqual(JSON.parse(readFileSync(join(book, 'output', 'toc.json'), 'utf8')), [
      { title: 'Sampling', level: 'chapter', page: 1, targetFile: 'sampling-alternate-test' },
      { title: 'Slides', level: 'section', page: 1, targetFile: 'sampling-alternate-test', variant: 'slides' },
    ])
  } finally {
    setProjectPathOverride('course-alternate-test')
    setProjectPathOverride('sampling-alternate-test')
    rmSync(root, { recursive: true, force: true })
  }
})
