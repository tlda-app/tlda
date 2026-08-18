#!/usr/bin/env node
// Did this branch land? Answered from content, so a squash cannot hide it.
//
// `main` here is assembled by cherry-pick, so every landed change exists as two
// shas — the author's and the copy — and `git merge-base --is-ancestor` reports
// fully-landed work as unmerged. AGENTS.md already says to check by commit
// SUBJECT instead. That works for a cherry-pick, which preserves the message,
// and fails for a SQUASH, which does not: `rc/anchored-list`'s component landed
// as one squashed commit, `f34e43f77`, and the check called the branch
// unlanded. On 2026-08-12 this class produced six false negatives in one night
// and sent agents chasing work that had already shipped; four of the five
// owners flagged were the artifact and one was real.
//
// A squash preserves the TREE, not the message — so ask git about content.
//
// The derivation, and it needs no new metadata because git already stores all
// of it:
//
//   A patch-id is a hash of a diff with whitespace and line numbers normalised.
//   Cherry-picking preserves it. Rebasing preserves it. And a squash commit's
//   diff IS the branch's NET diff, so the branch's net patch-id equals the
//   squash commit's patch-id. That is the whole trick: compare the branch's net
//   diff against every commit on main, not its commits one at a time.
//
//   `git cherry` already compares commits one at a time, which is exactly why
//   it misses a squash: no individual commit of the branch matches the one
//   combined commit on main.
//
// So three questions, cheapest first, and each names how it landed:
//
//   1. is-ancestor            -> merged, the ordinary way
//   2. net patch-id on main   -> landed squashed, or picked as one commit
//   3. every commit's patch-id on main -> landed cherry-pick by cherry-pick
//
// and if only some commits match, it says how many rather than "unlanded",
// because a partially-landed branch is a different problem from an ignored one
// and today they look identical.
//
// COST. One `git log -p | git patch-id` pass builds the index for every branch
// at once: about 25s for 1200 commits here, versus 70s to patch-id 300 commits
// one process at a time. Per branch after that is a pass over its own commits,
// which are few. That is what makes it runnable in a check table.
//
// WHAT IT CANNOT DO, stated rather than discovered later: a patch-id is a hash
// of the diff, so if the copy on `main` was edited on its way in — a conflict
// resolved differently, a rebase that shifted context beyond the normalisation
// — no id matches and this reports `open`. It is wrong in the safe direction:
// it never calls unlanded work landed. Treat `open` as "not proven landed".
import { execFile as execFileCb, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)
const MAX = 4 * 1024 * 1024

async function git(args) {
  const { stdout } = await execFile('git', args, { maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

// `git log -p` into `git patch-id` in ONE pipe. Spawning a process per commit
// is the obvious way and is ~15x slower, which is the difference between a
// check that runs and a check nobody enables.
function patchIdIndex(revRange, extra = []) {
  return new Promise((resolve, reject) => {
    const log = spawn('git', ['log', '-p', '--no-color', '--no-textconv', ...extra, revRange], { stdio: ['ignore', 'pipe', 'ignore'] })
    const ids = spawn('git', ['patch-id', '--stable'], { stdio: [log.stdout, 'pipe', 'ignore'] })
    let out = ''
    let size = 0
    ids.stdout.on('data', chunk => {
      size += chunk.length
      if (size > MAX * 16) return
      out += chunk
    })
    ids.on('error', reject)
    ids.on('close', () => {
      const map = new Map()
      for (const line of out.split('\n')) {
        const [patchId, commit] = line.trim().split(/\s+/)
        if (patchId && commit && !map.has(patchId)) map.set(patchId, commit)
      }
      resolve(map)
    })
  })
}

function netPatchId(base, tip) {
  return new Promise((resolve, reject) => {
    const diff = spawn('git', ['diff', '--no-color', base, tip], { stdio: ['ignore', 'pipe', 'ignore'] })
    const ids = spawn('git', ['patch-id', '--stable'], { stdio: [diff.stdout, 'pipe', 'ignore'] })
    let out = ''
    ids.stdout.on('data', c => { out += c })
    ids.on('error', reject)
    ids.on('close', () => resolve(out.trim().split(/\s+/)[0] || null))
  })
}

const args = process.argv.slice(2)
const trunk = process.env.TLDA_TRUNK || 'main'
const windowArg = args.find(a => a.startsWith('--window='))
const window = windowArg ? windowArg.split('=')[1] : '2000'
const branches = args.filter(a => !a.startsWith('--'))

const targets = branches.length
  ? branches
  : (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']))
      .split('\n').map(s => s.trim()).filter(b => b && b !== trunk)

process.stderr.write(`indexing ${window} commits of ${trunk}…\n`)
const index = await patchIdIndex(trunk, [`--max-count=${window}`])
process.stderr.write(`indexed ${index.size} patch-ids\n`)

const rows = []
for (const branch of targets) {
  let base
  try { base = (await git(['merge-base', trunk, branch])).trim() } catch { rows.push({ branch, state: 'no-merge-base' }); continue }
  const tip = (await git(['rev-parse', branch])).trim()
  if (base === tip) { rows.push({ branch, state: 'empty' }); continue }

  const ancestor = await execFile('git', ['merge-base', '--is-ancestor', branch, trunk]).then(() => true).catch(() => false)
  if (ancestor) { rows.push({ branch, state: 'merged', how: 'ancestor' }); continue }

  const net = await netPatchId(base, tip)
  if (net && index.has(net)) {
    rows.push({ branch, state: 'landed', how: 'squashed-or-single-pick', at: index.get(net).slice(0, 9) })
    continue
  }

  const own = await patchIdIndex(`${base}..${branch}`)
  const total = own.size
  const found = [...own.keys()].filter(id => index.has(id))
  if (total > 0 && found.length === total) {
    rows.push({ branch, state: 'landed', how: 'cherry-picked', at: `${total} commit(s)` })
  } else if (found.length > 0) {
    rows.push({ branch, state: 'partial', how: `${found.length}/${total} commit(s) on ${trunk}` })
  } else {
    rows.push({ branch, state: 'open', how: `${total} commit(s), none on ${trunk}` })
  }
}

const order = { merged: 0, landed: 1, partial: 2, open: 3 }
rows.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.branch.localeCompare(b.branch))
for (const r of rows) console.log(`${r.state.padEnd(8)} ${r.branch}${r.how ? `  (${r.how}${r.at ? ` ${r.at}` : ''})` : ''}`)

const counts = rows.reduce((acc, r) => ({ ...acc, [r.state]: (acc[r.state] || 0) + 1 }), {})
console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join('  ')}`)
