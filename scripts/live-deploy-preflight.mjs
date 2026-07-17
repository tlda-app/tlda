#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRepoIdentity } from '../shared/repo-identity.mjs'

function parseArgs(argv) {
  const args = { repo: process.cwd(), stamp: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo') {
      args.repo = argv[++i]
    } else if (arg === '--stamp') {
      args.stamp = argv[++i]
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

export function buildInfoFromIdentity(identity, builtAt = new Date().toISOString()) {
  return {
    gitSha: identity.gitSha,
    sha: identity.gitSha,
    ref: identity.ref,
    branch: identity.branch,
    dirty: identity.dirty,
    checkoutPath: identity.checkoutPath,
    builtAt,
  }
}

export function runLiveDeployPreflight({
  repoRoot = process.cwd(),
  stampPath = null,
  now = new Date(),
  resolveIdentity = resolveRepoIdentity,
  writeFile = writeFileSync,
} = {}) {
  const repo = resolve(repoRoot)
  const identity = resolveIdentity(repo)
  if (!identity.gitSha) {
    throw new Error('live deploy preflight failed: could not resolve committed HEAD')
  }
  if (identity.checkoutBranch !== 'main' || identity.isWorktree) {
    throw new Error(
      `live deploy preflight failed: deploy directly from the main checkout on branch main; got ${identity.checkoutBranch || 'detached HEAD'} at ${identity.checkoutPath}`,
    )
  }
  if (identity.dirty) {
    throw new Error(
      `live deploy preflight failed: ${identity.checkoutPath} has uncommitted changes; commit or stash before deploying live`,
    )
  }

  const target = stampPath ? resolve(stampPath) : join(identity.checkoutPath, 'server', 'build-info.json')
  const info = buildInfoFromIdentity(identity, now.toISOString())
  mkdirSync(dirname(target), { recursive: true })
  writeFile(target, `${JSON.stringify(info, null, 2)}\n`)
  return { identity, stampPath: target, buildInfo: info }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = runLiveDeployPreflight({ repoRoot: args.repo, stampPath: args.stamp })
  console.log(`live deploy preflight ok: ${result.buildInfo.gitSha} (${result.buildInfo.ref})`)
  console.log(`wrote ${result.stampPath}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.message || err)
    process.exit(1)
  })
}
