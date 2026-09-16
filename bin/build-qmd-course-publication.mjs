#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, relative, resolve } from 'node:path'

import { buildCoursePublication } from '../server/lib/course-publication-build.mjs'
import { deriveCourseAppSpec } from '../server/lib/course-app-build.mjs'
import { buildIncrementalQmd, quartoBookRoots } from '../server/lib/incremental-qmd-build.mjs'

function usage() {
  return 'usage: node bin/build-qmd-course-publication.mjs --source <course-checkout> --index <index-md> --output <dir> --static-builder <build-site.py> [--static-python <python>] [--figure-stamp N]'
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (!flag?.startsWith('--') || value === undefined) throw new Error(usage())
    args[flag.slice(2)] = value
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.source || !args.index || !args.output || !args['static-builder']) {
  console.error(usage())
  process.exit(2)
}

const courseDir = resolve(args.source)
const outputDir = resolve(args.output)
const indexFile = relative(courseDir, resolve(courseDir, args.index)).replace(/\\/g, '/')
const spec = deriveCourseAppSpec(courseDir, indexFile)
const staticBuilder = resolve(args['static-builder'])
const execFileAsync = promisify(execFile)
let renderCount = 0
const result = await buildCoursePublication({
  courseDir,
  indexFile,
  outputDir,
  render: async renderedDir => {
    renderCount += 1
    const roots = quartoBookRoots(courseDir)
    await buildIncrementalQmd({
      sourceDir: courseDir,
      outputDir: renderedDir,
      changedFiles: null,
      mainFiles: roots.length ? roots : [spec.index],
      name: 'course-publication',
      log: line => console.log(line),
      ...(args['figure-stamp'] !== undefined ? { figureStamp: Number(args['figure-stamp']) } : {}),
      projectMeta: { format: 'qmd', mainFile: roots[0] || spec.index },
      sourceScopeFiles: null,
      onProjectUpdate: null,
    })
  },
  assembleStatic: async ({ renderedDir, outputDir }) => {
    await execFileAsync(args['static-python'] || 'python3', [
      staticBuilder,
      '--course-dir', courseDir,
      '--book-dir', join(renderedDir, '_book'),
      '--site-dir', outputDir,
    ], {
      cwd: dirname(staticBuilder),
      env: { ...process.env, PYTHONPATH: join(dirname(staticBuilder), 'python') },
      maxBuffer: 16 * 1024 * 1024,
    })
  },
})
const appPages = JSON.parse(readFileSync(`${outputDir}/app/page-info.json`, 'utf8'))
console.log(JSON.stringify({
  ok: true,
  renderCount,
  documents: result.app.spec.documents.length,
  decks: result.app.spec.decks.length,
  assets: result.app.spec.assets.length,
  pages: appPages.length,
  output: outputDir,
}, null, 2))
