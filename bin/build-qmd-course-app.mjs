#!/usr/bin/env node
import { dirname, join, relative, resolve } from 'node:path'

import { assembleCourseAppSite } from '../server/lib/course-app-build.mjs'

function usage() {
  return [
    'usage: node bin/build-qmd-course-app.mjs --source <course-source> --index <index-md> --output <dir>',
    '  [--built <existing-tlda-output>]',
    '',
    'By default <course-source> is an existing TLDA project source/ directory',
    'and the command consumes its already-built sibling output/ directory.',
  ].join('\n')
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
if (!args.source || !args.index || !args.output) {
  console.error(usage())
  process.exit(2)
}

const sourceDir = resolve(args.source)
const indexFile = relative(sourceDir, resolve(sourceDir, args.index)).replace(/\\/g, '/')
const builtDir = resolve(args.built || join(dirname(sourceDir), 'output'))
const outputDir = resolve(args.output)
const result = assembleCourseAppSite(sourceDir, indexFile, builtDir, outputDir)
console.log(JSON.stringify({
  ok: true,
  source: sourceDir,
  built: builtDir,
  output: outputDir,
  documents: result.spec.documents.length,
  decks: result.spec.decks.length,
  assets: result.spec.assets.length,
  pages: result.pages.length,
}, null, 2))
