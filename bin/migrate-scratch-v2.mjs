#!/usr/bin/env node
// One-time migration: strip \begin{scratch}...\end{scratch} wrappers from
// .scratchinputs/*.tex files and update \inputscratch{path} lines in the
// main tex file to the new 3-arg format: \inputscratch{path}{label}{header}

import fs from 'fs'
import path from 'path'

const projectDir = process.argv[2]
if (!projectDir) {
  console.error('Usage: node migrate-scratch-v2.mjs <project-source-dir>')
  console.error('  e.g. node migrate-scratch-v2.mjs ~/work/tlda/server/projects/bregman/source')
  process.exit(1)
}

const scratchDir = path.join(projectDir, '.scratchinputs')
if (!fs.existsSync(scratchDir)) {
  console.log('No .scratchinputs directory found — nothing to migrate.')
  process.exit(0)
}

const files = fs.readdirSync(scratchDir).filter(f => f.endsWith('.tex') && f !== 'scratch-template.tex')
const migrated = []

for (const file of files) {
  const filePath = path.join(scratchDir, file)
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n')

  const beginMatch = lines[0]?.match(/^\\begin\{scratch\}\{([^}]+)\}\{([^}]+)\}/)
  if (!beginMatch) {
    // File has no wrapper — already raw content. Derive label from filename for the \inputscratch line update.
    const derivedLabel = file.replace(/\.tex$/, '').replace(/^scratch-/, 'scratch:')
    migrated.push({ file, scratchPath: `.scratchinputs/${file}`, label: derivedLabel, header: `${derivedLabel} — migrated` })
    console.log(`  RAW  ${file} — already unwrapped, derived label=${derivedLabel}`)
    continue
  }

  const label = beginMatch[1]
  const header = beginMatch[2]

  let innerLines = lines.slice(1)
  const endIdx = innerLines.findIndex(l => l.trim() === '\\end{scratch}')
  if (endIdx >= 0) innerLines = innerLines.slice(0, endIdx)
  while (innerLines.length > 0 && innerLines[innerLines.length - 1] === '') innerLines.pop()

  const newContent = innerLines.join('\n') + '\n'
  fs.writeFileSync(filePath, newContent, 'utf8')
  migrated.push({ file, scratchPath: `.scratchinputs/${file}`, label, header })
  console.log(`  OK   ${file} — stripped wrapper, label=${label}`)
}

// Find and update main tex file
const texFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.tex'))
for (const texFile of texFiles) {
  const texPath = path.join(projectDir, texFile)
  let content = fs.readFileSync(texPath, 'utf8')
  let changed = false

  for (const { scratchPath, label, header } of migrated) {
    // Match old 1-arg format: \inputscratch{path} (not followed by another {)
    const oldPattern = `\\inputscratch{${scratchPath}}`
    const idx = content.indexOf(oldPattern)
    if (idx >= 0) {
      const afterIdx = idx + oldPattern.length
      const nextChar = content[afterIdx]
      if (nextChar !== '{') {
        const newLine = `\\inputscratch{${scratchPath}}{${label}}{${header}}`
        content = content.substring(0, idx) + newLine + content.substring(afterIdx)
        changed = true
        console.log(`  TEX  ${texFile}: updated \\inputscratch for ${label}`)
      }
    }
  }

  if (changed) {
    fs.writeFileSync(texPath, content, 'utf8')
  }
}

// Update template to v2
const templatePath = path.join(scratchDir, 'scratch-template.tex')
if (fs.existsSync(templatePath)) {
  const templateContent = [
    '% scratch-template-version: 2',
    '\\usepackage{xcolor}',
    '\\newcommand{\\inputscratch}[3]{\\begingroup\\color[gray]{0.3}\\par\\noindent{\\footnotesize\\ttfamily[#3]}\\par\\label{#2}\\input{#1}\\endgroup\\par}',
    '',
  ].join('\n')
  fs.writeFileSync(templatePath, templateContent, 'utf8')
  console.log('  TPL  Updated scratch-template.tex to v2')
}

console.log(`\nMigrated ${migrated.length} scratch file(s).`)
