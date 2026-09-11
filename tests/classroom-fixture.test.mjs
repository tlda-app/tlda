import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { generateClassroomFixture, renderHomeworkVariants, stageRenderedVariantAssets } from './helpers/classroom-fixture.mjs'

// A course of its own, sharing no tooling with any other. Setup that only works
// against one particular course passes nothing here.
const COURSE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/classroom-course')
const TOOLING = {
  handoutGenerator: 'bin/make-handout.py',
  solutionFilter: 'homework/solution-callout.lua',
}

function tempDir(stem) {
  return fs.mkdtempSync(path.join(os.tmpdir(), stem))
}

test('root-level classroom variants carry nested Quarto assets with isolated names', () => {
  const root = tempDir('tlda-classroom-assets-')
  const inputDir = path.join(root, 'homework')
  const bookDir = path.join(root, '_book')
  try {
    fs.mkdirSync(path.join(inputDir, 'homework_files', 'figure-html'), { recursive: true })
    fs.mkdirSync(path.join(bookDir, 'site_libs'), { recursive: true })
    fs.writeFileSync(path.join(inputDir, 'homework_files', 'figure-html', 'plot.png'), 'plot')
    const renderedPath = path.join(bookDir, 'hw1-solution.html')
    fs.writeFileSync(renderedPath, '<link href="../site_libs/style.css"><img src="homework_files/figure-html/plot.png?v=1">')

    stageRenderedVariantAssets({
      fixtureDir: root,
      inputFile: 'homework/homework.qmd',
      renderedPath,
      outputFile: 'hw1-solution.html',
    })

    assert.equal(fs.readFileSync(renderedPath, 'utf8'), '<link href="site_libs/style.css"><img src="hw1-solution_files/figure-html/plot.png?v=1">')
    assert.equal(fs.readFileSync(path.join(bookDir, 'hw1-solution_files', 'figure-html', 'plot.png'), 'utf8'), 'plot')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a classroom fixture is generated from any Quarto book with its own tooling', () => {
  const dir = tempDir('tlda-classroom-fixture-')
  try {
    const fixture = generateClassroomFixture({ sourceRoot: COURSE, outDir: dir, ...TOOLING })
    assert.equal(fixture.sourceRoot, COURSE)
    assert.equal(fixture.homeworkPath, 'homework/hw1.qmd')
    assert.equal(fixture.title, 'Sample Course')
    assert.equal(fs.existsSync(path.join(dir, fixture.homeworkPath)), true)
    // The include closure follows the source, not a list of known filenames.
    assert.equal(fs.existsSync(path.join(dir, 'homework/shared-preamble.qmd')), true)
    assert.equal(fs.existsSync(path.join(dir, fixture.handoutGenerator)), true)
    assert.equal(fs.existsSync(path.join(dir, fixture.solutionFilter)), true)

    const quarto = YAML.parse(fs.readFileSync(path.join(dir, '_quarto.yml'), 'utf8'))
    assert.deepEqual(quarto.book.chapters, ['index.qmd', 'homework/hw1.qmd'])
    assert.equal(quarto.book.title, 'Sample Course')
    // No extension is enabled that the course does not have.
    assert.deepEqual(quarto.format.html.filters, ['homework/solution-callout.lua'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a course with no tooling at all still produces a fixture', () => {
  const dir = tempDir('tlda-classroom-bare-')
  try {
    const fixture = generateClassroomFixture({ sourceRoot: COURSE, outDir: dir })
    assert.equal(fixture.handoutGenerator, null)
    assert.deepEqual(fixture.extensions, [])
    const quarto = YAML.parse(fs.readFileSync(path.join(dir, '_quarto.yml'), 'utf8'))
    assert.deepEqual(quarto.format.html.filters, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('named tooling that is not there is named in the error, not copied silently', () => {
  const dir = tempDir('tlda-classroom-missing-')
  try {
    assert.throws(
      () => generateClassroomFixture({ sourceRoot: COURSE, outDir: dir, handoutGenerator: 'bin/nope.py' }),
      /--handout-generator bin\/nope\.py does not exist/,
    )
    assert.throws(
      () => generateClassroomFixture({ sourceRoot: COURSE, outDir: dir, extensions: ['no-such-extension'] }),
      /--extension not found/,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a source root is required — there is no default course', () => {
  assert.throws(() => generateClassroomFixture({ outDir: tempDir('tlda-classroom-noroot-') }), /sourceRoot is required/)
})

test('rendering refuses to produce a handout with no generator to strip solutions', async () => {
  await assert.rejects(
    renderHomeworkVariants({ sourceRoot: COURSE, outDir: tempDir('tlda-classroom-nogen-') }),
    /handout generator is required/,
  )
})

test('handout and solution artifacts are rendered through the course transforms', async () => {
  const dir = tempDir('tlda-classroom-render-')
  const steps = []
  try {
    const rendered = await renderHomeworkVariants({
      sourceRoot: COURSE,
      outDir: dir,
      outputStem: 'hw1',
      ...TOOLING,
      onProgress: event => { if (!event.raw) steps.push(event.step) },
    })
    const handout = fs.readFileSync(rendered.handoutHtml, 'utf8')
    const solution = fs.readFileSync(rendered.solutionHtml, 'utf8')
    const handoutSource = fs.readFileSync(path.join(dir, rendered.handoutSource), 'utf8')

    assert.match(solution, /Fifty-five/)
    assert.match(solution, /<strong>Solution<\/strong>/)
    assert.match(handoutSource, /#ans-sum \.callout-answer/)
    assert.doesNotMatch(handout, /Fifty-five/)
    assert.doesNotMatch(handout, /Three and a half/)
    assert.match(handout, /ans-sum/)

    // Silence for the length of a render is the failure this reports against.
    assert.deepEqual(steps, ['fixture', 'fixture', 'solution', 'handout-source', 'handout'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('fixture generation is deterministic for the same source tree', () => {
  const first = tempDir('tlda-classroom-a-')
  const second = tempDir('tlda-classroom-b-')
  try {
    const a = generateClassroomFixture({ sourceRoot: COURSE, outDir: first, ...TOOLING })
    const b = generateClassroomFixture({ sourceRoot: COURSE, outDir: second, ...TOOLING })
    assert.deepEqual(a.copiedFiles, b.copiedFiles)
    assert.equal(
      fs.readFileSync(path.join(first, '_quarto.yml'), 'utf8'),
      fs.readFileSync(path.join(second, '_quarto.yml'), 'utf8'),
    )
  } finally {
    fs.rmSync(first, { recursive: true, force: true })
    fs.rmSync(second, { recursive: true, force: true })
  }
})
