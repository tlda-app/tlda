import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { quartoBookToc, resolveQuartoBookPageSources } from './build-qmd.mjs'

test('book toc structure comes from _quarto.yml without reading rendered HTML', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-book-config-toc-'))
  try {
    writeFileSync(join(root, '_quarto.yml'), [
      'book:',
      '  chapters:',
      '    - part: index.qmd',
      '      chapters:',
      '        - lectures/sampling.qmd',
      '        - homework/hw1.handout.qmd',
      '',
    ].join('\n'))
    const pages = [
      { title: 'Course', source: { file: 'index.qmd' } },
      { title: 'Sampling', source: { file: 'lectures/sampling.qmd' } },
      { title: 'Homework 1', source: { file: 'homework/hw1.qmd' } },
      { title: 'Homework 1 — Solutions', source: { file: 'homework/hw1-solutions.qmd' } },
    ]

    assert.deepEqual(quartoBookToc(root, pages), [
      { title: 'Course', level: 'part', page: 1 },
      { title: 'Sampling', level: 'chapter', page: 2 },
      { title: 'Homework 1', level: 'chapter', page: 3 },
      { title: 'Homework 1 — Solutions', level: 'chapter', page: 4 },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('book toc rejects a render whose declared chapters changed order', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-book-config-order-'))
  try {
    writeFileSync(join(root, '_quarto.yml'), 'book:\n  chapters:\n    - first.qmd\n    - second.qmd\n')
    assert.throws(
      () => quartoBookToc(root, [
        { title: 'Second', source: { file: 'second.qmd' } },
        { title: 'First', source: { file: 'first.qmd' } },
      ]),
      /page order disagrees/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('book pages with output-file resolve to their authored source', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-book-output-file-source-'))
  try {
    writeFileSync(join(root, '_quarto.yml'), 'book:\n  chapters:\n    - homework.qmd\n')
    writeFileSync(join(root, 'homework.qmd'), '---\ntitle: Homework\noutput-file: homework-solutions.html\n---\n')
    assert.deepEqual(resolveQuartoBookPageSources(root, [{
      file: 'homework-solutions.html',
      source: { type: 'project-source', format: 'qmd', file: 'homework-solutions.qmd' },
    }]), [{
      file: 'homework-solutions.html',
      source: { type: 'project-source', format: 'qmd', file: 'homework.qmd' },
    }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
