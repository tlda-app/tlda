import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'

const REQUIRED_FILTERS = [
  'homework/assignment-callout.lua',
  'homework/solution-callout.lua',
  'bin/make-handout.py',
  'bin/answer-placement-warning.lua',
]

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function copyFile(root, out, relativePath) {
  const source = path.join(root, relativePath)
  const destination = path.join(out, relativePath)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

function copyTree(root, out, relativePath, copiedFiles = null) {
  const source = path.join(root, relativePath)
  if (!fs.existsSync(source)) return
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name)
    if (entry.isDirectory()) copyTree(root, out, child, copiedFiles)
    else {
      copyFile(root, out, child)
      copiedFiles?.add(child)
    }
  }
}

function flattenChapters(entries = [], found = []) {
  for (const entry of entries) {
    if (typeof entry === 'string') found.push(entry)
    else if (entry && typeof entry === 'object') {
      if (typeof entry.part === 'string') found.push(entry.part)
      flattenChapters(entry.chapters || [], found)
    }
  }
  return found
}

function qmdIncludes(source) {
  return [...source.matchAll(/\{\{<\s*include\s+([^>\s]+)\s*>\}\}/g)]
    .map(match => match[1].replace(/^['"]|['"]$/g, ''))
}

function includeClosure(root, start) {
  const pending = [start]
  const copied = new Set()
  while (pending.length) {
    const relativePath = pending.shift()
    if (copied.has(relativePath)) continue
    copied.add(relativePath)
    const source = readText(path.join(root, relativePath))
    const base = path.dirname(relativePath)
    for (const include of qmdIncludes(source)) {
      pending.push(path.normalize(path.join(base, include)))
    }
  }
  return [...copied].sort()
}

function writeRenderConfig(outDir, fixture, { filter = null, chapterPath = fixture.homeworkPath } = {}) {
  const filters = ['encrypt-solutions', 'image-toggle']
  if (filter) filters.push(filter)
  const config = {
    project: {
      type: 'book',
      resources: fixture.scheduleResources,
    },
    book: {
      title: 'QTM 285 Classroom Fixture',
      chapters: ['index.qmd', chapterPath],
    },
    format: {
      html: {
        filters,
        'callout-appearance': 'simple',
        'callout-icon': false,
        'embed-resources': false,
      },
    },
    execute: {
      echo: false,
      message: false,
      warning: false,
      freeze: false,
    },
  }
  fs.writeFileSync(path.join(outDir, '_quarto.yml'), YAML.stringify(config))
}

export function generateQtm285ClassroomFixture({
  sourceRoot = '/Users/skip/work/teaching/qtm285-1',
  outDir,
  homeworkPath = null,
} = {}) {
  if (!outDir) throw new Error('outDir is required')
  const quartoPath = path.join(sourceRoot, '_quarto.yml')
  const sourceQuarto = YAML.parse(readText(quartoPath))
  const chapters = flattenChapters(sourceQuarto.book?.chapters || [])
  const selectedHomework = homeworkPath || chapters.find(chapter =>
    chapter.startsWith('homework/') && chapter.endsWith('.qmd') && !chapter.includes('/old/')
  )
  if (!selectedHomework) throw new Error('no homework chapter found in _quarto.yml')

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const scheduleResources = (sourceQuarto.project?.resources || [])
    .filter(resource => /schedule/i.test(resource))
    .sort()
  const copiedFiles = new Set(['_quarto.yml', 'index.qmd'])
  fs.writeFileSync(path.join(outDir, 'index.qmd'), '---\ntitle: QTM 285 Classroom Fixture\n---\n')

  for (const relativePath of [
    ...scheduleResources,
    ...REQUIRED_FILTERS,
    ...includeClosure(sourceRoot, selectedHomework),
  ]) {
    copyFile(sourceRoot, outDir, relativePath)
    copiedFiles.add(relativePath)
  }
  for (const filter of ['_extensions/encrypt-solutions', '_extensions/image-toggle']) {
    copyTree(sourceRoot, outDir, filter, copiedFiles)
  }

  const fixture = {
    sourceRoot,
    outDir,
    bookConfig: '_quarto.yml',
    scheduleResources,
    homeworkPath: selectedHomework,
    handoutFilter: 'homework/assignment-callout.lua',
    handoutGenerator: 'bin/make-handout.py',
    solutionFilter: 'homework/solution-callout.lua',
    copiedFiles: [...copiedFiles].sort(),
  }
  writeRenderConfig(outDir, fixture, { filter: fixture.solutionFilter })
  return fixture
}

function execFileCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}

async function renderVariant({ fixtureDir, inputFile, fixture, filter = null, outputFile, quartoBin }) {
  writeRenderConfig(fixtureDir, fixture, { filter, chapterPath: inputFile })
  await execFileCapture(quartoBin, ['render', inputFile, '--to', 'html', '--output', outputFile], { cwd: fixtureDir })
  const renderedPath = path.join(fixtureDir, '_book', outputFile)
  if (!fs.existsSync(renderedPath)) {
    throw new Error(`Quarto did not produce ${renderedPath}`)
  }
  return renderedPath
}

export async function renderQtm285HomeworkVariants({
  sourceRoot = '/Users/skip/work/teaching/qtm285-1',
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-classroom-qtm285-')),
  homeworkPath = null,
  outputStem = null,
  quartoBin = 'quarto',
} = {}) {
  const fixture = generateQtm285ClassroomFixture({ sourceRoot, outDir, homeworkPath })
  const stem = outputStem || path.basename(fixture.homeworkPath, path.extname(fixture.homeworkPath))
  const solutionOutput = `${stem}-solution.html`
  const handoutOutput = `${stem}-handout.html`
  const solutionHtml = await renderVariant({
    fixtureDir: outDir,
    inputFile: fixture.homeworkPath,
    fixture,
    filter: fixture.solutionFilter,
    outputFile: solutionOutput,
    quartoBin,
  })
  const handoutSource = path.join(path.dirname(fixture.homeworkPath), `${path.basename(fixture.homeworkPath, path.extname(fixture.homeworkPath))}.handout.qmd`)
  await execFileCapture('python3', [fixture.handoutGenerator, fixture.homeworkPath, handoutSource], { cwd: outDir })
  const handoutHtml = await renderVariant({
    fixtureDir: outDir,
    inputFile: handoutSource,
    fixture,
    filter: null,
    outputFile: handoutOutput,
    quartoBin,
  })
  return {
    ...fixture,
    outDir,
    handoutHtml,
    solutionHtml,
    handoutSource,
    handoutOutput,
    solutionOutput,
    sourceFiles: fixture.copiedFiles.filter(file => file !== '_quarto.yml'),
  }
}
