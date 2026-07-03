#!/usr/bin/env node
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CODEX_MODELS,
  DEFAULT_MODEL,
  GOOSE_MODELS,
  MODEL_ALIASES,
  resolveClaudeModel,
  resolveCodexModel,
  resolveGooseModel,
} from '../bin/lib/spawn/models.mjs'
import { modelFamily, modelTrustTier } from '../shared/harness.ts'
import { modelSpawnCeiling } from '../server/lib/spawn-policy.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const baselinePath = resolve(repoRoot, 'test/fixtures/model-governance-parity.baseline.json')

function parseSharedHarnessAliasEntries() {
  const text = readFileSync(resolve(repoRoot, 'shared/harness.ts'), 'utf8')
  const entries = []
  const mapMatch = text.match(/const MODEL_ALIASES = new Map<string, string>\(\[\n([\s\S]*?)\n\]\)/)
  if (mapMatch) {
    for (const line of mapMatch[1].split(/\r?\n/)) {
      const match = line.match(/\['([^']+)', '([^']+)'\]/)
      if (match) entries.push({ source: 'shared/harness:MODEL_ALIASES', alias: match[1], id: match[2] })
    }
  }
  const setMatch = text.match(/const CLAUDE_MODEL_NAMES = new Set\(\[([^\]]*)\]\)/)
  if (setMatch) {
    for (const alias of [...setMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])) {
      entries.push({ source: 'shared/harness:CLAUDE_MODEL_NAMES', alias, id: null })
    }
  }
  return entries
}

function addCase(cases, row) {
  const key = [row.kind, row.requestedModel ?? '', row.source].join('\0')
  if (!cases.has(key)) cases.set(key, row)
}

function collectCases() {
  const cases = new Map()

  addCase(cases, { source: 'bin/lib/spawn/models:DEFAULT_MODEL', kind: 'claude', requestedModel: '', expectedId: DEFAULT_MODEL })
  addCase(cases, { source: 'bin/lib/spawn/models:GOOSE_DEFAULT', kind: 'goose', requestedModel: '', expectedId: GOOSE_MODELS.deepseek })
  addCase(cases, { source: 'bin/lib/spawn/models:CODEX_DEFAULT', kind: 'codex', requestedModel: '', expectedId: CODEX_MODELS.gpt })

  for (const [alias, id] of Object.entries(MODEL_ALIASES)) {
    addCase(cases, { source: 'bin/lib/spawn/models:MODEL_ALIASES.alias', kind: 'claude', requestedModel: alias, expectedId: id })
    addCase(cases, { source: 'bin/lib/spawn/models:MODEL_ALIASES.id', kind: 'claude', requestedModel: id, expectedId: id })
  }
  for (const [alias, id] of Object.entries(GOOSE_MODELS)) {
    addCase(cases, { source: 'bin/lib/spawn/models:GOOSE_MODELS.alias', kind: 'goose', requestedModel: alias, expectedId: id })
    addCase(cases, { source: 'bin/lib/spawn/models:GOOSE_MODELS.id', kind: 'goose', requestedModel: id, expectedId: id })
  }
  for (const [alias, id] of Object.entries(CODEX_MODELS)) {
    addCase(cases, { source: 'bin/lib/spawn/models:CODEX_MODELS.alias', kind: 'codex', requestedModel: alias, expectedId: id })
    addCase(cases, { source: 'bin/lib/spawn/models:CODEX_MODELS.id', kind: 'codex', requestedModel: id, expectedId: id })
  }

  for (const entry of parseSharedHarnessAliasEntries()) {
    const aliases = entry.id ? [entry.alias, entry.id] : [entry.alias]
    for (const requestedModel of aliases) {
      const kind = requestedModel.startsWith('gpt') || requestedModel === 'codex' ? 'codex'
        : requestedModel.includes('/') || requestedModel.includes('deepseek') ? 'goose'
        : 'claude'
      addCase(cases, {
        source: entry.source,
        kind,
        requestedModel,
        expectedId: entry.id,
      })
    }
  }

  return [...cases.values()].sort((a, b) => (
    a.kind.localeCompare(b.kind)
      || String(a.requestedModel).localeCompare(String(b.requestedModel))
      || a.source.localeCompare(b.source)
  ))
}

function resolveForKind(kind, requestedModel) {
  if (kind === 'claude') return resolveClaudeModel(requestedModel)
  if (kind === 'codex') return resolveCodexModel(requestedModel)
  if (kind === 'goose') return resolveGooseModel(requestedModel)
  throw new Error(`unknown kind ${kind}`)
}

function snapshot() {
  return collectCases().map((row) => {
    let concreteId = null
    let error = null
    try {
      concreteId = resolveForKind(row.kind, row.requestedModel)
      if (row.expectedId) assert.equal(concreteId, row.expectedId)
    } catch (err) {
      error = err.message
    }
    const classifyModel = concreteId ?? row.requestedModel
    const tuple = {
      source: row.source,
      kind: row.kind,
      requested_model: row.requestedModel,
      concrete_id: concreteId,
      family: modelFamily({ model: classifyModel, kind: row.kind }),
      trust_tier: modelTrustTier({ model: classifyModel, kind: row.kind }),
      spawn_ceiling: modelSpawnCeiling({}, { model: classifyModel, kind: row.kind }).capability,
      one_m_context: /\[1m\]$/u.test(String(concreteId || row.requestedModel || '')),
    }
    if (error) tuple.error = error
    return tuple
  })
}

function diffSnapshots(expected, actual) {
  const expectedText = JSON.stringify(expected, null, 2)
  const actualText = JSON.stringify(actual, null, 2)
  if (expectedText === actualText) return []
  const expectedByKey = new Map(expected.map((row) => [`${row.kind}\0${row.requested_model}\0${row.source}`, row]))
  const actualByKey = new Map(actual.map((row) => [`${row.kind}\0${row.requested_model}\0${row.source}`, row]))
  const keys = [...new Set([...expectedByKey.keys(), ...actualByKey.keys()])].sort()
  return keys
    .map((key) => {
      const before = expectedByKey.get(key) || null
      const after = actualByKey.get(key) || null
      if (JSON.stringify(before) === JSON.stringify(after)) return null
      return { key: key.replaceAll('\0', ' | '), before, after }
    })
    .filter(Boolean)
}

const args = new Set(process.argv.slice(2))
const current = snapshot()

if (args.has('--write')) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`wrote ${baselinePath} (${current.length} rows)`)
} else if (args.has('--check')) {
  if (!existsSync(baselinePath)) {
    console.error(`missing baseline: ${baselinePath}`)
    process.exit(1)
  }
  const expected = JSON.parse(readFileSync(baselinePath, 'utf8'))
  const diffs = diffSnapshots(expected, current)
  if (diffs.length) {
    console.error(JSON.stringify(diffs, null, 2))
    console.error(`model-governance parity failed: ${diffs.length} row(s) changed`)
    process.exit(1)
  }
  console.log(`model-governance parity ok (${current.length} rows)`)
} else {
  console.log(JSON.stringify(current, null, 2))
}
