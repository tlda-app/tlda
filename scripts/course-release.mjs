#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  deployCourseRelease,
  formatReleasePlan,
  planCourseRelease,
  readReleaseContract,
  readReleaseManifest,
  rollbackCourseRelease,
  stageCourseRelease,
} from './course-release-core.mjs'

function usage() {
  console.error('Usage: node scripts/course-release.mjs plan|stage --contract <release.json>')
  console.error('       node scripts/course-release.mjs deploy|rollback --manifest <release.json>')
}

function option(argv, name) {
  const index = argv.indexOf(name)
  return index < 0 ? null : argv[index + 1]
}

export function main(argv = process.argv.slice(2)) {
  const [command] = argv
  if (command === 'plan' || command === 'stage') {
    const path = option(argv, '--contract')
    if (!path) throw new Error('--contract is required')
    const plan = planCourseRelease(readReleaseContract(path))
    console.log(formatReleasePlan(plan))
    if (command === 'plan') return
    const staged = stageCourseRelease(plan)
    console.log(`staged ${staged.manifest.releaseId}`)
    console.log(staged.manifestPath)
    return
  }
  if (command === 'deploy' || command === 'rollback') {
    const path = option(argv, '--manifest')
    if (!path) throw new Error('--manifest is required')
    const manifest = readReleaseManifest(path)
    const result = command === 'deploy' ? deployCourseRelease(manifest) : rollbackCourseRelease(manifest)
    console.log(JSON.stringify(result))
    return
  }
  usage()
  throw new Error(`unknown release command: ${command || '(missing)'}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main()
  } catch (error) {
    console.error(error?.message || error)
    process.exit(1)
  }
}
