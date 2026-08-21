#!/usr/bin/env node

import { createHash, randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'fs/promises'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

export const MIGRATION = 'document-axes-v1'

const LEGACY_AXES = {
  svg: { sourceFormat: 'tex', renderer: 'latex', documentFormat: 'paged' },
  markdown: { sourceFormat: 'md', renderer: 'markdown', documentFormat: 'html' },
  html: { sourceFormat: 'html', renderer: 'identity', documentFormat: 'html' },
  slides: { sourceFormat: 'html', renderer: 'identity', documentFormat: 'slides' },
  qmd: { sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'html' },
  png: { sourceFormat: 'png', renderer: 'identity', documentFormat: 'paged' },
  pdf: { sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' },
  book: { sourceFormat: 'book', renderer: 'identity', documentFormat: 'book' },
}

const stable = value => JSON.stringify(value)
const digest = value => createHash('sha256').update(stable(value)).digest('hex')

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`)
  await rename(pending, path)
}

function convertedProject(project, label) {
  const hasAxes = project.sourceFormat && project.renderer && project.documentFormat
  if (!Object.hasOwn(project, 'format')) {
    if (!hasAxes) throw new Error(`${label} has neither legacy format nor complete document axes`)
    return project
  }
  const inferred = LEGACY_AXES[project.format]
  if (!inferred) throw new Error(`${label} has unknown legacy format ${JSON.stringify(project.format)}`)
  const axes = project.format === 'qmd' && project.renderedFormat === 'slides'
    ? { ...inferred, documentFormat: 'slides' }
    : inferred
  if (hasAxes && Object.entries(axes).some(([key, value]) => project[key] !== value)) {
    throw new Error(`${label} has conflicting legacy format and document axes`)
  }
  const { format: _removed, ...withoutFormat } = project
  return { ...withoutFormat, ...axes }
}

async function prepare(projectsDir, journalPath) {
  const entries = []
  for (const dirent of await readdir(projectsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const path = join(projectsDir, dirent.name, 'project.json')
    if (!existsSync(path)) continue
    let before
    try { before = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { throw new Error(`${relative(projectsDir, path)} is not valid JSON: ${error.message}`) }
    const after = convertedProject(before, relative(projectsDir, path))
    entries.push({ path: relative(projectsDir, path), before, after, beforeHash: digest(before), afterHash: digest(after) })
  }
  const journal = { migration: MIGRATION, state: 'prepared', entries }
  await writeJsonAtomic(journalPath, journal)
  return journal
}

async function loadJournal(path) {
  const journal = JSON.parse(await readFile(path, 'utf8'))
  if (journal.migration !== MIGRATION || !Array.isArray(journal.entries)) throw new Error(`Invalid ${MIGRATION} journal`)
  return journal
}

export async function migrateDocumentAxes(projectsDir, { recover = false, failAfter = Infinity } = {}) {
  projectsDir = resolve(projectsDir)
  const journalPath = join(projectsDir, '.migrations', `${MIGRATION}.json`)
  let journal = existsSync(journalPath) ? await loadJournal(journalPath) : await prepare(projectsDir, journalPath)
  const desiredKey = recover ? 'before' : 'after'
  const desiredHashKey = recover ? 'beforeHash' : 'afterHash'
  journal = { ...journal, state: recover ? 'recovering' : 'applying' }
  await writeJsonAtomic(journalPath, journal)
  let changed = 0
  for (const entry of journal.entries) {
    const path = join(projectsDir, entry.path)
    const current = JSON.parse(await readFile(path, 'utf8'))
    const currentHash = digest(current)
    if (currentHash === entry[desiredHashKey]) continue
    const allowedHash = recover ? entry.afterHash : entry.beforeHash
    if (currentHash !== allowedHash) throw new Error(`${entry.path} changed after the migration journal was prepared`)
    await writeJsonAtomic(path, entry[desiredKey])
    changed += 1
    if (changed >= failAfter) throw new Error('Injected document-axes migration interruption')
  }
  journal = { ...journal, state: recover ? 'recovered' : 'complete', completedAt: new Date().toISOString() }
  await writeJsonAtomic(journalPath, journal)
  return { journalPath, state: journal.state, changed }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const recover = args[0] === '--recover'
  const projectsDir = recover ? args[1] : args[0]
  if (!projectsDir) {
    console.error(`Usage: node scripts/migrate-document-axes-v1.mjs [--recover] <projects-dir>`)
    process.exitCode = 2
  } else {
    migrateDocumentAxes(projectsDir, { recover })
      .then(result => console.log(`${result.state}: ${result.journalPath}`))
      .catch(error => { console.error(error.message); process.exitCode = 1 })
  }
}
