#!/usr/bin/env node
// Every symbol the out-of-repo bots import from '@tlda/bot' must actually be
// exported by it.
//
// This exists because a resolution check is not an export check. On 2026-07-25
// the bots were moved to ~/work/tlda-bots and a static pass confirmed all 60
// import specifiers resolved to real files — which was true and useless:
// '@tlda/bot' resolved fine while missing two of the eleven symbols the bots
// name. The dev bot died at startup on
//
//   SyntaxError: The requested module '@tlda/bot' does not provide an export
//   named 'getActiveConfigName'
//
// The miss came from reading only single-line imports; dev-bot.mjs imports its
// symbols in a multi-line block. So this parses both forms, and compares
// against the package's real exports rather than against a hand-kept list.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BOTS_ROOT = process.env.TLDA_BOTS_ROOT || '/Users/skip/work/tlda-bots'

if (!existsSync(BOTS_ROOT)) {
  console.log(`bot package surface: skipped (no ${BOTS_ROOT})`)
  process.exit(0)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.mjs')) out.push(full)
  }
  return out
}

// Both `import { a } from '@tlda/bot'` and a multi-line brace block.
const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]@tlda\/bot['"]/gs

const needed = new Map()
for (const file of walk(BOTS_ROOT)) {
  const src = readFileSync(file, 'utf8')
  for (const match of src.matchAll(IMPORT_RE)) {
    for (const raw of match[1].split(',')) {
      const symbol = raw.trim().split(/\s+as\s+/)[0].trim()
      if (!symbol) continue
      if (!needed.has(symbol)) needed.set(symbol, [])
      needed.get(symbol).push(file.slice(BOTS_ROOT.length + 1))
    }
  }
}

assert.ok(needed.size > 0, 'found no @tlda/bot imports — the scan is broken, not the bots')

const pkg = await import('../packages/bot/index.mjs')
const missing = [...needed.keys()].filter(symbol => !(symbol in pkg))

if (missing.length) {
  for (const symbol of missing) {
    console.error(`  MISSING '${symbol}' — imported by ${needed.get(symbol).join(', ')}`)
  }
  assert.fail(`@tlda/bot is missing ${missing.length} symbol(s) the bots import`)
}

console.log(`bot package surface: ok (${needed.size} symbols across ${new Set([...needed.values()].flat()).size} bot files)`)
