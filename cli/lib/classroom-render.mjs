import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'

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
  if (!fs.existsSync(source)) return false
  let copiedAny = false
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const child = path.join(relativePath, entry.name)
    if (entry.isDirectory()) copiedAny = copyTree(root, out, child, copiedFiles) || copiedAny
    else {
      copyFile(root, out, child)
      copiedFiles?.add(child)
      copiedAny = true
    }
  }
  return copiedAny
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
  const filters = [...fixture.extensions]
  if (filter) filters.push(filter)
  const config = {
    project: {
      type: 'book',
      resources: fixture.scheduleResources,
    },
    book: {
      title: fixture.title,
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

/**
 * Copy one homework chapter out of a Quarto book into a self-contained fixture
 * directory, along with whatever course tooling the caller names.
 *
 * Nothing about a particular course is built in. `sourceRoot` is required, and
 * every filter, generator and extension is a path the caller supplies relative
 * to that root; a course that has none of them still produces a fixture.
 */
export function generateClassroomFixture({
  sourceRoot,
  outDir,
  homeworkPath = null,
  title = null,
  handoutGenerator = null,
  solutionFilter = null,
  supportFiles = [],
  extensions = [],
} = {}) {
  if (!sourceRoot) throw new Error('sourceRoot is required')
  if (!outDir) throw new Error('outDir is required')
  const quartoPath = path.join(sourceRoot, '_quarto.yml')
  if (!fs.existsSync(quartoPath)) {
    throw new Error(`${sourceRoot} is not a Quarto book: no _quarto.yml`)
  }
  const sourceQuarto = YAML.parse(readText(quartoPath))
  const chapters = flattenChapters(sourceQuarto.book?.chapters || [])
  const selectedHomework = homeworkPath || chapters.find(chapter =>
    chapter.startsWith('homework/') && chapter.endsWith('.qmd') && !chapter.includes('/old/')
  )
  if (!selectedHomework) throw new Error('no homework chapter found in _quarto.yml')
  if (!fs.existsSync(path.join(sourceRoot, selectedHomework))) {
    throw new Error(`homework chapter not found in ${sourceRoot}: ${selectedHomework}`)
  }

  const tooling = [
    ['--handout-generator', handoutGenerator],
    ['--solution-filter', solutionFilter],
    ...supportFiles.map(file => ['--support-file', file]),
  ].filter(([, value]) => value)
  for (const [flag, relativePath] of tooling) {
    if (!fs.existsSync(path.join(sourceRoot, relativePath))) {
      throw new Error(`${flag} ${relativePath} does not exist under ${sourceRoot}`)
    }
  }

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })

  const bookTitle = title || sourceQuarto.book?.title || path.basename(sourceRoot)
  const scheduleResources = (sourceQuarto.project?.resources || [])
    .filter(resource => /schedule/i.test(resource))
    .sort()
  const copiedFiles = new Set(['_quarto.yml', 'index.qmd'])
  fs.writeFileSync(path.join(outDir, 'index.qmd'), `---\ntitle: ${JSON.stringify(bookTitle)}\n---\n`)

  for (const relativePath of [
    ...scheduleResources,
    ...tooling.map(([, value]) => value),
    ...includeClosure(sourceRoot, selectedHomework),
  ]) {
    copyFile(sourceRoot, outDir, relativePath)
    copiedFiles.add(relativePath)
  }
  const copiedExtensions = extensions.filter(name =>
    copyTree(sourceRoot, outDir, path.join('_extensions', name), copiedFiles)
  )
  const missingExtensions = extensions.filter(name => !copiedExtensions.includes(name))
  if (missingExtensions.length) {
    throw new Error(`--extension not found under ${sourceRoot}/_extensions: ${missingExtensions.join(', ')}`)
  }

  const fixture = {
    sourceRoot,
    outDir,
    title: bookTitle,
    bookConfig: '_quarto.yml',
    scheduleResources,
    homeworkPath: selectedHomework,
    handoutGenerator,
    solutionFilter,
    supportFiles: [...supportFiles],
    extensions: copiedExtensions,
    copiedFiles: [...copiedFiles].sort(),
  }
  writeRenderConfig(outDir, fixture, { filter: fixture.solutionFilter })
  return fixture
}

function runChild(command, args, { cwd, env, onOutput }) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd, env, maxBuffer: 20 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
    if (onOutput) {
      child.stdout?.on('data', chunk => onOutput(String(chunk)))
      child.stderr?.on('data', chunk => onOutput(String(chunk)))
    }
  })
}

/**
 * Quarto caches compiled Sass in a Deno KV database under `$HOME`, so a render
 * dies with `unable to open database file` wherever HOME is not writable — which
 * is every agent working under a permission fence. Redirecting HOME for the whole
 * process instead breaks tlda, whose own config lives under the real HOME, so the
 * writable HOME is given to the Quarto child only.
 */
function quartoEnv(outDir) {
  const home = path.join(outDir, '.quarto-home')
  fs.mkdirSync(home, { recursive: true })
  return { ...process.env, HOME: home }
}

async function renderVariant({ fixtureDir, inputFile, fixture, filter = null, outputFile, quartoBin, onOutput }) {
  writeRenderConfig(fixtureDir, fixture, { filter, chapterPath: inputFile })
  await runChild(quartoBin, ['render', inputFile, '--to', 'html', '--output', outputFile], {
    cwd: fixtureDir,
    env: quartoEnv(fixtureDir),
    onOutput,
  })
  const renderedPath = path.join(fixtureDir, '_book', outputFile)
  if (!fs.existsSync(renderedPath)) {
    throw new Error(`Quarto did not produce ${renderedPath}`)
  }
  return renderedPath
}

/**
 * Render the solution and handout variants of one homework chapter.
 *
 * The handout is produced by the course's own generator, which rewrites the
 * master source into a student version. There is no default generator: without
 * one there is no way to know which blocks hold solutions, and rendering the
 * master unchanged would publish them.
 *
 * `onProgress` is called with a short line per step and with each line the child
 * processes write. A Quarto render of a real chapter takes minutes; a caller that
 * passes nothing prints nothing, which reads as a hang.
 */
export async function renderHomeworkVariants({
  sourceRoot,
  outDir,
  homeworkPath = null,
  title = null,
  outputStem = null,
  quartoBin = 'quarto',
  handoutGenerator = null,
  solutionFilter = null,
  supportFiles = [],
  extensions = [],
  onProgress = () => {},
} = {}) {
  if (!handoutGenerator) {
    throw new Error('a handout generator is required: pass --handout-generator <path relative to the homework root>')
  }
  onProgress({ step: 'fixture', message: `Collecting ${homeworkPath || 'the first homework chapter'} from ${sourceRoot}` })
  const fixture = generateClassroomFixture({
    sourceRoot, outDir, homeworkPath, title, handoutGenerator, solutionFilter, supportFiles, extensions,
  })
  onProgress({ step: 'fixture', message: `${fixture.copiedFiles.length} files collected into ${outDir}` })

  const stem = outputStem || path.basename(fixture.homeworkPath, path.extname(fixture.homeworkPath))
  const solutionOutput = `${stem}-solution.html`
  const handoutOutput = `${stem}-handout.html`
  const onOutput = text => onProgress({ step: 'child', message: text, raw: true })

  onProgress({ step: 'solution', message: `Rendering solutions: ${fixture.homeworkPath} → ${solutionOutput}` })
  const solutionHtml = await renderVariant({
    fixtureDir: outDir,
    inputFile: fixture.homeworkPath,
    fixture,
    filter: fixture.solutionFilter,
    outputFile: solutionOutput,
    quartoBin,
    onOutput,
  })

  const handoutSource = path.join(
    path.dirname(fixture.homeworkPath),
    `${path.basename(fixture.homeworkPath, path.extname(fixture.homeworkPath))}.handout.qmd`,
  )
  onProgress({ step: 'handout-source', message: `Generating handout source with ${handoutGenerator}` })
  await runChild('python3', [fixture.handoutGenerator, fixture.homeworkPath, handoutSource], {
    cwd: outDir,
    env: process.env,
    onOutput,
  })

  onProgress({ step: 'handout', message: `Rendering handout: ${handoutSource} → ${handoutOutput}` })
  const handoutHtml = await renderVariant({
    fixtureDir: outDir,
    inputFile: handoutSource,
    fixture,
    filter: null,
    outputFile: handoutOutput,
    quartoBin,
    onOutput,
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
