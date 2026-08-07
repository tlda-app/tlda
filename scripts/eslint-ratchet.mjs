import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { ESLint } from 'eslint'

const root = process.cwd()
const baselinePath = path.join(root, 'config', 'eslint-baseline.json')

function diagnosticKey(filePath, message) {
  const relativePath = path.relative(root, filePath).split(path.sep).join('/')
  const rule = message.ruleId ?? '(fatal)'
  // React compiler diagnostics include absolute paths, line numbers, and source
  // excerpts. Keep the stable headline so the baseline survives line movement.
  const headline = message.message.split('\n\n', 1)[0].replaceAll(root, '<root>')
  return `${relativePath}\t${message.severity}\t${rule}\t${headline}`
}

function collect(results) {
  const diagnostics = {}
  let errors = 0
  let warnings = 0

  for (const result of results) {
    errors += result.errorCount
    warnings += result.warningCount
    for (const message of result.messages) {
      const key = diagnosticKey(result.filePath, message)
      diagnostics[key] = (diagnostics[key] ?? 0) + 1
    }
  }

  return { errors, warnings, diagnostics }
}

// The gate blocks on errors. Warnings are still counted, still printed, and
// still recorded in the baseline — they are just not a reason to fail.
//
// Severity 1 is where ESLint puts the rules that cannot be certain, and three
// of the four warnings that first failed this ratchet were `exhaustive-deps`
// reporting dep arrays that are already complete: the rule tracks whole
// identifiers and cannot express "this closure only reads `.exactName`". A
// signature like that can never be cleared, only ignored — and taking its
// advice in `src/App.tsx` would have torn down the index chat subscription on
// every poll.
//
// A gate that fails on something nobody can fix is a gate people route around,
// which is the failure `server/lib/fleet-store-async-methods.mjs` already names
// in its own comment:
//
//   a rule that flagged all 400-odd sites at once would have been a rule nobody
//   could act on — and per eslint.config.js, a lint everyone must ignore is a
//   lint that catches nothing.
//
// Promote a rule to severity 2 in eslint.config.js when it should block.
const BLOCKING_SEVERITY = 2

function compare(current, baseline) {
  const regressions = []
  for (const [key, count] of Object.entries(current.diagnostics)) {
    const [, severity] = key.split('\t')
    if (Number(severity) !== BLOCKING_SEVERITY) continue
    const allowed = baseline.diagnostics[key] ?? 0
    if (count > allowed) regressions.push({ key, count, allowed })
  }
  return regressions
}

function countNewWarnings(current, baseline) {
  let signatures = 0
  for (const [key, count] of Object.entries(current.diagnostics)) {
    const [, severity] = key.split('\t')
    if (Number(severity) === BLOCKING_SEVERITY) continue
    if (count > (baseline.diagnostics[key] ?? 0)) signatures += 1
  }
  return signatures
}

const eslint = new ESLint()
const current = collect(await eslint.lintFiles(['.']))

if (process.argv.includes('--print-baseline')) {
  process.stdout.write(`${JSON.stringify({ version: 1, ...current }, null, 2)}\n`)
  process.exit(0)
}

const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'))
if (baseline.version !== 1 || typeof baseline.diagnostics !== 'object') {
  throw new Error(`Unsupported ESLint baseline format in ${baselinePath}`)
}

const regressions = compare(current, baseline)
const newWarningSignatures = countNewWarnings(current, baseline)
console.log(
  `ESLint debt: ${current.errors} errors, ${current.warnings} warnings ` +
  `(baseline ${baseline.errors} errors, ${baseline.warnings} warnings)`,
)
if (newWarningSignatures > 0) {
  console.log(
    `ESLint ratchet: ${newWarningSignatures} new warning signature(s), not blocking. ` +
    'Run `npx eslint <path>` to read them.',
  )
}

if (regressions.length === 0) {
  console.log('ESLint ratchet passed: no new error diagnostics.')
  process.exit(0)
}

console.error(`ESLint ratchet failed: ${regressions.length} new error signature(s).`)
for (const { key, count, allowed } of regressions) {
  const [file, severity, rule, message] = key.split('\t')
  console.error(`- ${file} [severity ${severity}] ${rule}: ${message} (${count} > ${allowed})`)
}
process.exit(1)
