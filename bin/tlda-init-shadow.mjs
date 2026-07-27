#!/usr/bin/env node
/**
 * tlda-init-shadow <project>
 *
 * Initialize (or re-initialize) a tlda project's shadow repo by filtering
 * the project's working-copy git history down to paper-scope paths only.
 *
 * Paper-scope = files pdflatex actually opened during the last build,
 * augmented with bibtex inputs and svg figure sources (read from
 * server/projects/<name>/output/relevant-files.json).
 *
 * If a shadow repo already exists, it's renamed to shadow-repo-dirty.<ts>
 * before the new one is created. The dirty version stays on disk for
 * inspection / recovery.
 *
 * Usage:
 *   bin/tlda-init-shadow.mjs <project>
 *   tlda init-shadow <project>
 */

import { readFileSync, existsSync, renameSync } from 'fs'
import { join } from 'path'

const SERVER_PROJECTS_DIR = '/Users/skip/work/tlda/server/projects'

const projectName = process.argv[2]
if (!projectName) {
  console.error('Usage: tlda-init-shadow <project>')
  console.error('  Filters the project\'s working-copy git history down to paper-scope')
  console.error('  paths only, producing a clean shadow repo.')
  process.exit(1)
}

const projDir = join(SERVER_PROJECTS_DIR, projectName)
if (!existsSync(join(projDir, 'project.json'))) {
  console.error(`Project not found: ${projectName}`)
  process.exit(1)
}

const project = JSON.parse(readFileSync(join(projDir, 'project.json'), 'utf8'))
const sourceDir = project.sourceDir
if (!sourceDir || !existsSync(join(sourceDir, '.git'))) {
  console.error(`Project "${projectName}" sourceDir is not a git repo: ${sourceDir}`)
  console.error('  Filter-init requires an extant git repo to filter.')
  process.exit(1)
}

const relPath = join(projDir, 'output', 'relevant-files.json')
if (!existsSync(relPath)) {
  console.error(`relevant-files.json missing for "${projectName}".`)
  console.error('  Run a successful build first so paper-scope is known.')
  process.exit(1)
}

const relData = JSON.parse(readFileSync(relPath, 'utf8'))
const allFiles = Array.isArray(relData?.files) ? relData.files : []
// Scope is project-relative — the working copy names the same files the same way.
const scope = allFiles.filter(p => typeof p === 'string' && p.length > 0)

if (scope.length === 0) {
  console.error(`Paper-scope is empty for "${projectName}". Aborting.`)
  process.exit(1)
}

console.log(`Project: ${projectName}`)
console.log(`Source:  ${sourceDir}`)
console.log(`Paths:   ${scope.length} paper-scope files`)

// Rename existing shadow out of the way (preserve as dirty backup).
const shadowDir = join(projDir, 'shadow-repo')
if (existsSync(shadowDir)) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dirtyDir = join(projDir, `shadow-repo-dirty-${ts}`)
  renameSync(shadowDir, dirtyDir)
  console.log(`Renamed existing shadow → ${dirtyDir}`)
}

// Initialize project store (so server-lib functions can resolve paths).
const ps = await import('/Users/skip/work/tlda/server/lib/project-store.mjs')
ps.initProjectStore(SERVER_PROJECTS_DIR)

const sr = await import('/Users/skip/work/tlda/server/lib/shadow-repo.mjs')
try {
  const repo = await sr.initShadowFromProjectRepo(projectName, sourceDir, scope)
  console.log(`OK new shadow at: ${repo}`)
} catch (e) {
  console.error(`FAIL: ${e.message}`)
  process.exit(1)
}
