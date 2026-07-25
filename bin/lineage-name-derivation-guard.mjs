#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ROOTS = ['agent-launch', 'mcp-server', 'server', 'shared', 'src']
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'server/public'])
const PROHIBITED = [
  'shared/lineage-name.mjs',
  'prettyNameForFriendlyName',
  'baseName(',
  'nameForPhase',
  'phaseFromName',
  'ALL_PHASES',
  'assignPhase',
  'retireFromLineage',
  'getLineageDay',
  'lineage-retire',
]

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    const rel = path.relative(ROOT, full)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(rel) && !SKIP_DIRS.has(entry.name)) yield* walk(full)
    } else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) {
      yield full
    }
  }
}

const hits = []
for (const root of CHECK_ROOTS) {
  const dir = path.join(ROOT, root)
  if (!fs.existsSync(dir)) continue
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file)
    if (rel === 'bin/lineage-name-derivation-guard.mjs') continue
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      for (const needle of PROHIBITED) {
        if (line.includes(needle)) hits.push(`${rel}:${index + 1}: ${needle}`)
      }
    })
  }
}

if (hits.length) {
  console.error('Lineage names are opaque server/app data; found retired derivation surface:')
  for (const hit of hits) console.error(`  ${hit}`)
  process.exit(1)
}
