#!/usr/bin/env node

import fs from 'node:fs'

import { classifyLaunder } from './lib/launder-classifier.mjs'
import { launderExamples } from '../test/fixtures/launder-examples.mjs'

const LABELS = ['flag', 'clean', 'log_only']

function parseArgs(argv) {
  const args = {
    input: null,
    seed: 1,
    testFraction: 0.5,
    errorsOut: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--input') args.input = argv[++i]
    else if (arg === '--seed') args.seed = Number(argv[++i])
    else if (arg === '--test-fraction') args.testFraction = Number(argv[++i])
    else if (arg === '--errors-out') args.errorsOut = argv[++i]
    else if (arg === '--help' || arg === '-h') usage(0)
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!Number.isFinite(args.seed)) throw new Error('--seed must be numeric')
  if (!(args.testFraction > 0 && args.testFraction < 1)) {
    throw new Error('--test-fraction must be between 0 and 1')
  }

  return args
}

function usage(code) {
  console.log(`Usage: node bin/launder-eval.mjs [--input labeled.jsonl] [options]

Options:
  --input PATH          Optional labeled JSONL. Defaults to seed fixtures.
  --seed N              Deterministic shuffle seed (default: 1)
  --test-fraction P     Held-out fraction (default: 0.5)
  --errors-out PATH     Write misclassified held-out rows as JSONL
`)
  process.exit(code)
}

function loadRows(input) {
  if (!input) {
    return launderExamples.map(example => ({
      eventId: example.id,
      text: example.text,
      context: example.context,
      humanLabel: example.label,
      humanReasonCode: example.reasonCode,
      provenance: { source: example.provenance },
    }))
  }

  return fs.readFileSync(input, 'utf8')
    .split(/\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new Error(`${input}:${index + 1}: invalid JSON: ${error.message}`)
      }
    })
}

function validateRows(rows) {
  const seen = new Set()
  for (const row of rows) {
    if (!row.eventId) throw new Error('row missing eventId')
    if (seen.has(row.eventId)) throw new Error(`duplicate eventId: ${row.eventId}`)
    seen.add(row.eventId)
    if (!LABELS.includes(row.humanLabel)) {
      throw new Error(`event ${row.eventId} has invalid humanLabel: ${row.humanLabel}`)
    }
    if (!row.humanReasonCode) throw new Error(`event ${row.eventId} missing humanReasonCode`)
    if (!row.provenance?.source) throw new Error(`event ${row.eventId} missing provenance.source`)
  }
}

function shuffled(rows, seed) {
  const output = [...rows]
  let state = seed >>> 0
  for (let i = output.length - 1; i > 0; i--) {
    state = (1664525 * state + 1013904223) >>> 0
    const j = state % (i + 1)
    ;[output[i], output[j]] = [output[j], output[i]]
  }
  return output
}

function initConfusion() {
  return Object.fromEntries(LABELS.map(actual => [
    actual,
    Object.fromEntries(LABELS.map(predicted => [predicted, 0])),
  ]))
}

function evaluate(rows) {
  const confusion = initConfusion()
  const errors = []
  let correct = 0

  for (const row of rows) {
    const actual = classifyLaunder({ text: row.text, context: row.context || {} })
    const predicted = actual.decision
    confusion[row.humanLabel][predicted] += 1
    if (predicted === row.humanLabel) correct += 1
    else {
      errors.push({
        eventId: row.eventId,
        actual: row.humanLabel,
        predicted,
        humanReasonCode: row.humanReasonCode,
        modelReasonCode: actual.reasonCode,
        matchedSpan: actual.features.matchedSpan,
        provenance: row.provenance,
      })
    }
  }

  return {
    n: rows.length,
    correct,
    accuracy: rows.length ? correct / rows.length : 0,
    confusion,
    errors,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const rows = loadRows(args.input)
  validateRows(rows)
  const splitRows = shuffled(rows, args.seed)
  const testSize = Math.max(1, Math.round(splitRows.length * args.testFraction))
  const test = splitRows.slice(0, testSize)
  const train = splitRows.slice(testSize)
  const heuristic = evaluate(test)

  if (args.errorsOut) {
    fs.writeFileSync(args.errorsOut, heuristic.errors.map(row => JSON.stringify(row)).join('\n') + (heuristic.errors.length ? '\n' : ''))
  }

  console.log(JSON.stringify({
    input: args.input || 'test/fixtures/launder-examples.mjs',
    seed: args.seed,
    split: {
      train: train.length,
      test: test.length,
      testFraction: args.testFraction,
    },
    labels: Object.fromEntries(LABELS.map(label => [label, rows.filter(row => row.humanLabel === label).length])),
    heldOut: {
      type: 'rule-cascade',
      n: heuristic.n,
      correct: heuristic.correct,
      accuracy: heuristic.accuracy,
      confusion: heuristic.confusion,
      errors: heuristic.errors,
    },
  }, null, 2))
}

main()
