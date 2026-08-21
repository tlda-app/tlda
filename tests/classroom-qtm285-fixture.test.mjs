import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { generateQtm285ClassroomFixture, renderQtm285HomeworkVariants } from './helpers/qtm285-fixture.mjs'

test('QTM 285 classroom fixture is generated from the real book and filters', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-qtm285-fixture-'))
  try {
    const fixture = generateQtm285ClassroomFixture({ outDir: dir })
    assert.equal(fixture.sourceRoot, '/Users/skip/work/teaching/qtm285-1')
    assert.equal(fixture.homeworkPath, 'homework/week0-homework.qmd')
    assert.deepEqual(fixture.scheduleResources, ['scratch/fall-2026-development-schedule.html'])
    assert.equal(fs.existsSync(path.join(dir, fixture.homeworkPath)), true)
    assert.equal(fs.existsSync(path.join(dir, 'homework/shared-code.qmd')), true)
    assert.equal(fs.existsSync(path.join(dir, fixture.handoutFilter)), true)
    assert.equal(fs.existsSync(path.join(dir, fixture.solutionFilter)), true)
    assert.equal(fs.existsSync(path.join(dir, fixture.handoutGenerator)), true)
    assert.equal(fs.existsSync(path.join(dir, 'bin/answer-placement-warning.lua')), true)
    assert.equal(fs.existsSync(path.join(dir, '_extensions/encrypt-solutions/encrypt-solutions.lua')), true)
    assert.equal(fs.existsSync(path.join(dir, '_extensions/image-toggle/image-toggle.lua')), true)

    const quarto = YAML.parse(fs.readFileSync(path.join(dir, '_quarto.yml'), 'utf8'))
    assert.deepEqual(quarto.book.chapters, ['index.qmd', 'homework/week0-homework.qmd'])
    assert.deepEqual(quarto.project.resources, ['scratch/fall-2026-development-schedule.html'])
    assert.deepEqual(quarto.format.html.filters, ['encrypt-solutions', 'image-toggle', 'homework/solution-callout.lua'])
    assert.match(fs.readFileSync(path.join(dir, 'homework/assignment-callout.lua'), 'utf8'), /callout-solution[\s\S]*return \{\}/)
    assert.match(fs.readFileSync(path.join(dir, 'homework/solution-callout.lua'), 'utf8'), /type = "solution"/)
    assert.match(fs.readFileSync(path.join(dir, 'bin/make-handout.py'), 'utf8'), /callout-solution[\s\S]*callout-answer/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('QTM 285 fixture renders handout and solution artifacts through the real course transforms', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-qtm285-render-'))
  try {
    const rendered = await renderQtm285HomeworkVariants({ outDir: dir, outputStem: 'hw1' })
    const handout = fs.readFileSync(rendered.handoutHtml, 'utf8')
    const solution = fs.readFileSync(rendered.solutionHtml, 'utf8')
    const handoutSource = fs.readFileSync(path.join(dir, rendered.handoutSource), 'utf8')
    assert.match(solution, /callout-solution/)
    assert.match(solution, /It.s biggest for list 3 and smallest for list 2/)
    assert.match(handoutSource, /callout-answer/)
    assert.doesNotMatch(handout, /callout-solution/)
    assert.doesNotMatch(handout, /It.s biggest for list 3 and smallest for list 2/)
    assert.match(handout, /exr-calculations-1/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('QTM 285 fixture generation is deterministic for the same source tree', () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-qtm285-fixture-a-'))
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-qtm285-fixture-b-'))
  try {
    const a = generateQtm285ClassroomFixture({ outDir: first })
    const b = generateQtm285ClassroomFixture({ outDir: second })
    assert.deepEqual(
      a.copiedFiles.map(file => file.replace(first, '<out>')),
      b.copiedFiles.map(file => file.replace(second, '<out>')),
    )
    assert.equal(
      fs.readFileSync(path.join(first, '_quarto.yml'), 'utf8'),
      fs.readFileSync(path.join(second, '_quarto.yml'), 'utf8'),
    )
  } finally {
    fs.rmSync(first, { recursive: true, force: true })
    fs.rmSync(second, { recursive: true, force: true })
  }
})
