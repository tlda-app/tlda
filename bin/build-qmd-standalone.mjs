#!/usr/bin/env node
/**
 * Standalone adapter for the shared incremental Quarto build/link engine.
 *
 * Calls the SAME `buildIncrementalQmd` the app build-service adapter calls,
 * with no app process, no project store and no app credentials: a materialized
 * source tree in, a rendered output tree out. Used by static publishing and by
 * acceptance runs against a course copy.
 *
 *   node bin/build-qmd-standalone.mjs --source <dir> --output <dir>
 *     [--changed a.qmd,b.qmd] [--main root.qmd] [--name label]
 *     [--figure-stamp 123]
 *
 * `--changed` takes a comma-separated list of project-relative paths. Omitted
 * (or empty output) means unknown and takes the engine's whole-project branch —
 * the first incremental run, not a separate renderer.
 */

import { readFileSync } from 'node:fs'

import {
  buildIncrementalQmd,
  quartoBookRoots,
} from '../server/lib/incremental-qmd-build.mjs'

function usage() {
  return [
    'usage: node bin/build-qmd-standalone.mjs --source <dir> --output <dir>',
    '  [--changed a.qmd,b.qmd] [--main root.qmd] [--name label] [--figure-stamp N]',
  ].join('\n')
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}\n${usage()}`)
    const key = flag.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}\n${usage()}`)
    args[key] = value
    i += 1
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.source || !args.output) {
  console.error(usage())
  process.exit(2)
}

const changedFiles = args.changed
  ? args.changed.split(',').map(s => s.trim()).filter(Boolean)
  : null
const bookRoots = quartoBookRoots(args.source)
const mainFiles = args.main ? [args.main] : (bookRoots.length > 0 ? bookRoots : ['index.qmd'])

const result = await buildIncrementalQmd({
  sourceDir: args.source,
  outputDir: args.output,
  changedFiles,
  mainFiles,
  name: args.name || 'standalone',
  log: (line) => console.log(line),
  ...(args['figure-stamp'] !== undefined ? { figureStamp: Number(args['figure-stamp']) } : {}),
  projectMeta: { format: 'qmd', mainFile: mainFiles[0] },
  sourceScopeFiles: null,
  onProjectUpdate: null,
})

const pageInfo = JSON.parse(readFileSync(`${args.output}/page-info.json`, 'utf8'))
console.log(JSON.stringify({
  ok: true,
  pages: pageInfo.length,
  manifestPages: result.manifest.pages.length,
  regenerateBookTocs: result.regenerateBookTocs,
}, null, 2))
