'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { answerBaseline } = require('../src/answer-baseline')
const { problems } = require('../src/submission')

test('loads the handout baseline and catches an answer written below its box', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-homework-baseline-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const support = path.join(root, 'homework.qmd.support')
  fs.mkdirSync(support)
  const file = path.join(root, 'homework.qmd')
  const template = '::: {#ans-exr-photo}\n(your answer here)\n:::\n'
  fs.writeFileSync(path.join(support, 'baseline.txt'), template)
  const source = `---\ntlda-answer-baseline: "homework.qmd.support/baseline.txt"\n---\n\n${template}my-photo.png\n`

  const baseline = answerBaseline(file, source)
  assert.equal(baseline, template)
  assert.match(problems(source, () => true, baseline)[0], /underneath the answer box/)
})

test('will not read a baseline outside the assignment folder', () => {
  const file = path.join(os.tmpdir(), 'assignment', 'homework.qmd')
  const source = '---\ntlda-answer-baseline: "../private.txt"\n---\n'
  assert.equal(answerBaseline(file, source), undefined)
})
