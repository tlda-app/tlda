#!/usr/bin/env node

import fs from 'node:fs'

const LABELS = ['intervene', 'suppress', 'log_only']

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

  if (!args.input) throw new Error('--input is required')
  if (!Number.isFinite(args.seed)) throw new Error('--seed must be numeric')
  if (!(args.testFraction > 0 && args.testFraction < 1)) {
    throw new Error('--test-fraction must be between 0 and 1')
  }

  return args
}

function usage(code) {
  console.log(`Usage: node bin/todd-disclosure-eval.mjs --input labeled.jsonl [options]

Options:
  --seed N              Deterministic shuffle seed (default: 1)
  --test-fraction P     Held-out fraction (default: 0.5)
  --errors-out PATH     Write misclassified held-out rows as JSONL
`)
  process.exit(code)
}

function loadRows(input) {
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
    if (!row.humanReasonCode) {
      throw new Error(`event ${row.eventId} missing humanReasonCode`)
    }
    if (!row.provenance?.getThread || !row.provenance?.source) {
      throw new Error(`event ${row.eventId} missing provenance`)
    }
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

function tokens(row) {
  const textTokens = String(row.text || '')
    .toLowerCase()
    .match(/[a-z][a-z0-9_'-]{2,}/g) || []
  const featureTokens = Object.entries(row.features || {})
    .filter(([, value]) => value === true)
    .map(([key]) => `feature:${key}`)
  return [...textTokens, ...featureTokens]
}

function trainNaiveBayes(rows) {
  const docCounts = new Map()
  const tokenCounts = new Map()
  const totalTokens = new Map()
  const vocab = new Set()

  for (const label of LABELS) {
    docCounts.set(label, 0)
    tokenCounts.set(label, new Map())
    totalTokens.set(label, 0)
  }

  for (const row of rows) {
    const label = row.humanLabel
    docCounts.set(label, docCounts.get(label) + 1)
    for (const token of tokens(row)) {
      vocab.add(token)
      const counts = tokenCounts.get(label)
      counts.set(token, (counts.get(token) || 0) + 1)
      totalTokens.set(label, totalTokens.get(label) + 1)
    }
  }

  return { docCounts, tokenCounts, totalTokens, vocab, totalDocs: rows.length }
}

function predict(model, row) {
  let best = null
  const rowTokens = tokens(row)
  const vocabSize = model.vocab.size || 1

  for (const label of LABELS) {
    const prior = (model.docCounts.get(label) + 1) / (model.totalDocs + LABELS.length)
    let score = Math.log(prior)
    const denom = model.totalTokens.get(label) + vocabSize
    const counts = model.tokenCounts.get(label)
    for (const token of rowTokens) {
      score += Math.log(((counts.get(token) || 0) + 1) / denom)
    }
    if (!best || score > best.score) best = { label, score }
  }

  return best.label
}

function initConfusion() {
  return Object.fromEntries(LABELS.map(actual => [
    actual,
    Object.fromEntries(LABELS.map(predicted => [predicted, 0])),
  ]))
}

function evaluate(rows, predictLabel) {
  const confusion = initConfusion()
  const errors = []
  let correct = 0

  for (const row of rows) {
    const predicted = predictLabel(row)
    confusion[row.humanLabel][predicted] += 1
    if (predicted === row.humanLabel) correct += 1
    else {
      errors.push({
        eventId: row.eventId,
        timestamp: row.timestamp,
        agentId: row.agentId,
        actual: row.humanLabel,
        predicted,
        humanReasonCode: row.humanReasonCode,
        modelDecision: row.modelDecision,
        modelReasonCode: row.modelReasonCode,
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
  const testSize = Math.round(splitRows.length * args.testFraction)
  const test = splitRows.slice(0, testSize)
  const train = splitRows.slice(testSize)
  const model = trainNaiveBayes(train)
  const classifier = evaluate(test, row => predict(model, row))
  const heuristic = evaluate(test, row => LABELS.includes(row.modelDecision) ? row.modelDecision : 'suppress')

  if (args.errorsOut) {
    fs.writeFileSync(args.errorsOut, classifier.errors.map(row => JSON.stringify(row)).join('\n') + (classifier.errors.length ? '\n' : ''))
  }

  console.log(JSON.stringify({
    input: args.input,
    seed: args.seed,
    split: {
      train: train.length,
      test: test.length,
      testFraction: args.testFraction,
    },
    labels: Object.fromEntries(LABELS.map(label => [label, rows.filter(row => row.humanLabel === label).length])),
    classifier: {
      type: 'multinomial-naive-bayes',
      features: ['text tokens', 'boolean disclosure features'],
      n: classifier.n,
      correct: classifier.correct,
      accuracy: classifier.accuracy,
      confusion: classifier.confusion,
      errors: classifier.errors,
    },
    heuristicBaseline: {
      type: 'existing modelDecision as label',
      n: heuristic.n,
      correct: heuristic.correct,
      accuracy: heuristic.accuracy,
      confusion: heuristic.confusion,
      errors: heuristic.errors,
    },
  }, null, 2))
}

main()
