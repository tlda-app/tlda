import assert from 'node:assert/strict'
import test from 'node:test'

import katex from 'katex'

import { extractMacros } from '../scripts/extract-preamble.js'

test('DeclarePairedDelimiter unbraced names do not overwrite native delimiters', () => {
  const macros = extractMacros(String.raw`
    \DeclarePairedDelimiter\norm{\lVert}{\rVert}
    \DeclarePairedDelimiter\round{\lfloor}{\rceil}
    \DeclarePairedDelimiter\floor{\lfloor}{\rfloor}
    \DeclarePairedDelimiter\ceil{\lceil}{\rceil}
    \newcommand{\qqtext}[1]{\quad\text{#1}\quad}
  `)

  assert.equal(macros['\\norm'], String.raw`\lVert #1 \rVert`)
  assert.equal(macros['\\round'], String.raw`\lfloor #1 \rceil`)
  assert.equal(macros['\\floor'], String.raw`\lfloor #1 \rfloor`)
  assert.equal(macros['\\ceil'], String.raw`\lceil #1 \rceil`)
  assert.equal(Object.hasOwn(macros, '\\lfloor'), false)
  assert.equal(Object.hasOwn(macros, '\\lceil'), false)

  assert.doesNotThrow(() => {
    katex.renderToString(String.raw`\lfloor x \rfloor`, { throwOnError: true, macros })
  })
  assert.doesNotThrow(() => {
    katex.renderToString(String.raw`\floor{x}`, { throwOnError: true, macros })
  })
})

test('DeclarePairedDelimiter braced names are still supported', () => {
  const macros = extractMacros(String.raw`
    \DeclarePairedDelimiter{\inner}{\langle}{\rangle}
  `)

  assert.equal(macros['\\inner'], String.raw`\langle #1 \rangle`)
})
