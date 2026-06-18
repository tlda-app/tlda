#!/usr/bin/env node

import { fileURLToPath } from 'url'

import { resolveRigEnv } from './rig-env.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const [key, ...value] = arg.slice(2).split('=')
    args[key] = value.length ? value.join('=') : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
  }
  return args
}

function isUsableUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function checkRigHealth(options = {}) {
  let env
  const problems = []

  try {
    env = resolveRigEnv(options)
  } catch (e) {
    return {
      ok: false,
      problems: [`rig manifest could not be read: ${e.message}`],
      env: {
        manifestPath: null,
        manifest: null,
        viewer: null,
        doc: options.doc || 'bregman',
        noAuth: false,
      },
    }
  }

  if (!env.manifestPath) problems.push('no rig manifest was found')
  if (!env.manifest || typeof env.manifest !== 'object') {
    problems.push('rig manifest is not a JSON object')
  }
  if (!isUsableUrl(env.viewer)) {
    problems.push('rig manifest must provide an http(s) viewer URL')
  }
  if (typeof env.manifest?.doc !== 'string' || !env.manifest.doc.trim()) {
    problems.push('rig manifest must provide a non-empty doc')
  }
  if (typeof env.manifest?.noAuth !== 'boolean') {
    problems.push('rig manifest must provide boolean noAuth')
  }

  return {
    ok: problems.length === 0,
    problems,
    env,
  }
}

export function runRigHealthSmoke(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv)
  const result = checkRigHealth({ rig: args.rig, doc: args.doc })

  if (result.ok) {
    io.log(`rig-health-smoke PASS  doc=${result.env.doc}  viewer=${result.env.viewer}  noAuth=${result.env.noAuth}  rig=${result.env.manifestPath}`)
    return 0
  }

  io.error('rig-health-smoke FAIL')
  for (const problem of result.problems) io.error(`  - ${problem}`)
  if (result.env.manifestPath) io.error(`  rig=${result.env.manifestPath}`)
  return 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runRigHealthSmoke())
}
