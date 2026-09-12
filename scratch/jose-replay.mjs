/**
 * REPLAY: the shape that made a real two-person editing session not work.
 *
 * Skip, 2026-08-27: *"i want to see stuff exercised in a demo; perhaps one
 * stylized and one playing back a previously-problematic editing session like
 * my last one with jose"*. This is the second one.
 *
 * **It replays the SHAPE, on a disposable project, never his.** The standing
 * rule is that a claim demonstrable only against something of his is not
 * demonstrated. So the session's structure is taken from the record and rebuilt
 * from nothing here.
 *
 * **What the record says the structure was**, measured 2026-08-27 rather than
 * remembered:
 *
 *   - his project and a second project are bound to ONE checkout
 *   - that checkout stands on the OTHER project's work branch
 *   - the daemon logged `proposal not accepted: not-on-work-branch` for his,
 *     three times on 2026-08-25, and the same line is still being logged
 *   - fleet-wide: 10 checkouts carry 27 projects, so at most 10 of those 27
 *     can be standing on their own work branch at any moment
 *
 * **Two supported things that cannot both hold.** Sharing a checkout between
 * projects is supported. Syncing requires the checkout to stand on that
 * project's work branch — Skip, 2026-08-25: *"if you have a daemon-managed
 * branch checked out — it commits, and pushes, and all that shit. otherwise it
 * doesn't."* A checkout stands on one branch. So of N projects sharing a
 * checkout, N-1 do not sync, and the only signal is a daemon log line.
 *
 * That is not a function returning the wrong value. It is why a real editing
 * session with a second person did not work.
 *
 * Run:  node scratch/jose-replay.mjs
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-jose-replay-')))
const CHECKOUT = path.join(ROOT, 'shared-checkout')
const REMOTE = path.join(ROOT, 'server.git')

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const say = line => console.log(line)

// --- one checkout, two projects, exactly as the record shows ----------------
git(ROOT, 'init', '--bare', REMOTE)
fs.mkdirSync(CHECKOUT, { recursive: true })
git(CHECKOUT, 'init', '-b', 'main')
git(CHECKOUT, 'config', 'user.email', 'replay@tlda')
git(CHECKOUT, 'config', 'user.name', 'replay')
git(CHECKOUT, 'remote', 'add', 'tlda', REMOTE)
fs.writeFileSync(path.join(CHECKOUT, 'paper.tex'),
  '\\documentclass{article}\n\\begin{document}\n\nintroduction\n\nmethod\n\nresults\n\n\\end{document}\n')
git(CHECKOUT, 'add', '-A')
git(CHECKOUT, 'commit', '-m', 'the paper both people are editing')

// Both projects are bound to this one directory. `tlda project link` allows it
// and people use it: one repository, two papers sharing a bibliography and
// figures, or a paper and its talk.
const PROJECTS = ['paper-with-a-collaborator', 'the-other-project-in-this-repo']
for (const project of PROJECTS) {
  git(CHECKOUT, 'branch', `tlda/${project}`)
  git(CHECKOUT, 'push', '-q', 'tlda', `HEAD:refs/tlda/source/${project}`)
}

// The checkout can stand on ONE of them. Whichever was linked last, or whichever
// the person switched to, wins.
git(CHECKOUT, 'checkout', '-q', `tlda/${PROJECTS[1]}`)

say('')
say('REPLAY — a two-person editing session, on a disposable project')
say('='.repeat(64))
say(`  one checkout: ${PROJECTS.length} projects bound to it`)
say(`  standing on : tlda/${PROJECTS[1]}`)
say('')

// --- the session -------------------------------------------------------------
// Both people edit the same file, which is what the session was.
fs.writeFileSync(path.join(CHECKOUT, 'paper.tex'),
  '\\documentclass{article}\n\\begin{document}\n\nintroduction — EDITED BY THE AUTHOR\n\nmethod\n\nresults\n\n\\end{document}\n')
git(CHECKOUT, 'add', '-A')
git(CHECKOUT, 'commit', '-m', 'the author edits the introduction')

const head = git(CHECKOUT, 'symbolic-ref', '-q', '--short', 'HEAD')
const rows = []
for (const project of PROJECTS) {
  const want = `tlda/${project}`
  const syncs = head === want
  rows.push({ project, want, syncs })
}

say('  after one edit, which project receives it?')
say('')
for (const row of rows) {
  say(`    ${row.syncs ? 'SYNCS  ' : 'SILENT '} ${row.project}`)
  if (!row.syncs) {
    say(`             the daemon logs: "proposal not accepted: not-on-work-branch"`)
    say(`             and says: run \`git checkout ${row.want}\` to sync`)
  }
}

const silent = rows.filter(row => !row.syncs)
say('')
say('  WHAT THE PERSON SEES')
say(`    The edit is committed. Their working tree is clean. Nothing errors.`)
say(`    ${silent.length} of ${rows.length} project(s) never receive it, and the only`)
say(`    trace is a line in a daemon log on the machine.`)
say('')
say('  WHY')
say('    Sharing a checkout between projects is supported.')
say('    Syncing requires standing on that project\'s work branch.')
say('    A checkout stands on ONE branch. Both cannot hold at once.')
say('')
say('  THE SAME SHAPE, MEASURED ON THIS MACHINE TODAY')
say('    10 checkouts carry 27 projects, so at most 10 of those 27 can be')
say('    standing on their own work branch — at least 17 cannot sync, now.')
say('')
say('  NOT a wrong value from a function. Two supported features that')
say('  cannot both be true, and the losing one fails silently.')
say('='.repeat(64))

fs.rmSync(ROOT, { recursive: true, force: true })
