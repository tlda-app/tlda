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

function compare(current, baseline) {
  const regressions = []
  for (const [key, count] of Object.entries(current.diagnostics)) {
    const allowed = baseline.diagnostics[key] ?? 0
    if (count > allowed) regressions.push({ key, count, allowed })
  }
  return regressions
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
console.log(
  `ESLint debt: ${current.errors} errors, ${current.warnings} warnings ` +
  `(baseline ${baseline.errors} errors, ${baseline.warnings} warnings)`,
)

if (regressions.length === 0) {
  console.log('ESLint ratchet passed: no new diagnostics.')
  process.exit(0)
}

console.error(`ESLint ratchet failed: ${regressions.length} new diagnostic signature(s).`)
for (const { key, count, allowed } of regressions) {
  const [file, severity, rule, message] = key.split('\t')
  console.error(`- ${file} [severity ${severity}] ${rule}: ${message} (${count} > ${allowed})`)
}
process.exit(1)
