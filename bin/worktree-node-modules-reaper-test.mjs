#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { reapWorktreeNodeModules } from '../agent-runtime/worktree-node-modules-reaper.mjs'

const root = await mkdtemp(join(tmpdir(), 'tlda-node-modules-reaper-'))
const oldWorktree = join(root, 'old')
const activeWorktree = join(root, 'active')
const recentWorktree = join(root, 'recent')
for (const worktree of [oldWorktree, activeWorktree, recentWorktree]) {
  await mkdir(join(worktree, 'node_modules'), { recursive: true })
  await writeFile(join(worktree, 'node_modules', 'package'), 'x')
}
await utimes(join(oldWorktree, 'node_modules'), new Date(1_000), new Date(1_000))
await utimes(join(activeWorktree, 'node_modules'), new Date(2_000), new Date(2_000))
await utimes(join(recentWorktree, 'node_modules'), new Date(3_000), new Date(3_000))

const removed = []
const result = await reapWorktreeNodeModules({
  repoRoot: root,
  worktrees: [root, oldWorktree, activeWorktree, recentWorktree],
  activeCwds: new Set([join(activeWorktree, 'src')]),
  budgetBytes: 2,
  remove: async path => { removed.push(path) },
})

assert.deepEqual(removed, [join(oldWorktree, 'node_modules'), join(recentWorktree, 'node_modules')])
assert.equal(result.pinned[0].worktree, activeWorktree)
assert(result.overBudgetBytes > 0, 'an active worktree may keep the cache over budget')
console.log('worktree node_modules reaper test passed')
