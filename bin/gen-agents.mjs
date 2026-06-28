#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templatePath = path.join(repoRoot, '.CLAUDE.md')
const outputPath = path.join(repoRoot, 'AGENTS.md')

function resolveInclude(rawPath) {
  if (rawPath.startsWith('~/')) return path.join(os.homedir(), rawPath.slice(2))
  if (rawPath.startsWith('/')) return rawPath
  return path.resolve(repoRoot, rawPath)
}

function expandIncludes(text) {
  return text.split('\n').map((line) => {
    const match = line.match(/^@(.+)\s*$/)
    if (!match) return line
    const includePath = resolveInclude(match[1])
    return fs.readFileSync(includePath, 'utf8').replace(/\n$/, '')
  }).join('\n')
}

function generatedText() {
  const template = fs.readFileSync(templatePath, 'utf8')
  return expandIncludes(template)
}

function main() {
  const next = generatedText()
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : ''
    if (current !== next) {
      console.error('AGENTS.md is stale; run bin/gen-agents.mjs')
      process.exit(1)
    }
    return
  }
  fs.writeFileSync(outputPath, next)
}

main()
