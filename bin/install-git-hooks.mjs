#!/usr/bin/env node
// Install tlda's git hooks into .git/hooks/.
// Run once after clone or after adding new hooks under bin/git-hooks/.

import { execSync } from 'child_process'
import { readdirSync, copyFileSync, chmodSync, existsSync, statSync } from 'fs'
import { resolve, join, basename } from 'path'

const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()
const hooksDir = join(repoRoot, '.git', 'hooks')
const sourceDir = join(repoRoot, 'bin', 'git-hooks')

if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
  console.log(`no hooks to install — ${sourceDir} missing`)
  process.exit(0)
}

for (const name of readdirSync(sourceDir)) {
  const src = join(sourceDir, name)
  const dst = join(hooksDir, name)
  copyFileSync(src, dst)
  chmodSync(dst, 0o755)
  console.log(`installed: ${name}`)
}
