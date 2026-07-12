import assert from 'node:assert/strict'
import test from 'node:test'

import { reflowTexSourceByWord } from '../server/lib/word-synctex.mjs'

test('word synctex reflows ordinary prose into exact source-column tokens', () => {
  const { text, lineMap } = reflowTexSourceByWord('Alpha beta, gamma.', 'paper.tex')

  assert.equal(text, 'Alpha\nbeta,\ngamma.')
  assert.deepEqual(lineMap.map(row => ({
    line: row.line,
    startCol: row.startCol,
    endCol: row.endCol,
    text: row.text,
    structural: row.structural,
    unsafe: row.unsafe,
  })), [
    { line: 1, startCol: 0, endCol: 5, text: 'Alpha', structural: undefined, unsafe: undefined },
    { line: 1, startCol: 6, endCol: 11, text: 'beta,', structural: undefined, unsafe: undefined },
    { line: 1, startCol: 12, endCol: 18, text: 'gamma.', structural: undefined, unsafe: undefined },
  ])
})

test('word synctex abstains from structural commands and inline math lines', () => {
  const { text, lineMap } = reflowTexSourceByWord('\\section{Intro}\nText with $x+y$ inline.', 'paper.tex')

  assert.equal(text, '\\section{Intro}\nText with $x+y$ inline.')
  assert.equal(lineMap[0].structural, true)
  assert.equal(lineMap[1].structural, true)
  assert.equal(lineMap[1].startCol, 0)
  assert.equal(lineMap[1].endCol, 'Text with $x+y$ inline.'.length)
})

test('word synctex keeps unsafe math environments as whole-line unsafe rows', () => {
  const { lineMap } = reflowTexSourceByWord('\\begin{align}\na &= b+c\n\\end{align}', 'paper.tex')

  assert.deepEqual(lineMap.map(row => ({
    line: row.line,
    startCol: row.startCol,
    endCol: row.endCol,
    unsafe: row.unsafe,
    structural: row.structural,
  })), [
    { line: 1, startCol: 0, endCol: 13, unsafe: true, structural: false },
    { line: 2, startCol: 0, endCol: 8, unsafe: true, structural: false },
    { line: 3, startCol: 0, endCol: 11, unsafe: true, structural: false },
  ])
})
