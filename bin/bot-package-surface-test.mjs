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
//   named 'getActiveEnvName'
//
// The miss came from reading only single-line imports; dev-bot.mjs imports its
// symbols in a multi-line block. So this parses both forms, and compares
// against the package's real exports rather than against a hand-kept list.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import ts from 'typescript'

const BOTS_ROOT = process.env.TLDA_BOTS_ROOT || join(homedir(), 'work', 'tlda-bots')

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

const needed = new Map()
for (const file of walk(BOTS_ROOT)) {
  const src = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== '@tlda/bot') continue
    const bindings = statement.importClause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const symbol = element.propertyName?.text || element.name.text
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
