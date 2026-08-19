#!/usr/bin/env node
//
// **The server rebases. It refuses only when a person has to decide.**
//
// Skip specified this and the design says it in his words — *"we cancel all the
// other builds. Try to rebase. And start again"*, and *"rebase when it is
// mechanical; refuse when it is a judgement."*
//
// The bundle carrier shipped as fast-forward-or-refuse, which is half of that
// rule. It was a REGRESSION rather than a simplification: `submit()` has done
// the server-side rebase all along, so the JSON carrier rebased while the bundle
// carrier — the one his daemon uses — did not.
//
// **What refuse-only costs is not tidiness.** With several people or agents
// editing, a client that can only retry is beaten again while it retries: no
// queue, no ordering, no bound on how many times it loses. His words: *"you can
// just get, like, rejected and rejected and rejected because other people are
// editing code. Like, you can't have a priority queue that works this way."*
//
// Four cases, and the fourth is the only one the author ever hears about:
//
//   1. different files            → rebased and accepted, both survive
//   2. same file, different lines → rebased and accepted, both edits survive
//   3. a deletion that lost a race → rebased and accepted, the file stays gone
//   4. same lines                  → refused, because that is a judgement
//
// Case 3 exists because absence IS removal now. Before complete-tree a deletion
// was a separate list and an unclassifiable path was rare; now a push that drops
// a file would be unrebaseable and would lose every race it entered.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { createSourceProposal } from '../daemon/source-proposal.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'server-rebase-'))
const project = 'paper'
const lifecycle = createSourceLifecycleStore({ root, project, context: { format: 'svg', mainFile: 'main.tex' } })

// A checkout that proposes, so the bundles are real ones built the way the
// daemon builds them rather than hand-assembled.
function checkout(name) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', name], ['config', 'user.email', `${name}@test`]]) {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  return { dir, proposal: createSourceProposal({ sourceDir: dir, project }) }
}

const write = (c, file, text) => {
  fs.mkdirSync(path.dirname(path.join(c.dir, file)), { recursive: true })
  fs.writeFileSync(path.join(c.dir, file), text)
}
const remove = (c, file) => fs.rmSync(path.join(c.dir, file), { force: true })

// Take the server's accepted revision into a checkout: fetch the objects AND
// record what the checkout now holds. The mirror writes `shadow/HEAD` in
// production; without it a proposal is parented on nothing, which is a root
// commit sharing no history with the head — correctly unrebaseable, and not the
// case under test here.
async function adopt(c, head) {
  await c.proposal.ingest(await store.bundleSince(project, head, {}))
  spawnSync('git', ['--git-dir', path.join(c.dir, '.git'), 'update-ref', 'refs/tlda/shadow/HEAD', head])
}

// Propose from a checkout and hand the bundle to the accept, exactly as the
// route does.
async function propose(c, members) {
  await c.proposal.proposeCommit({ members, message: 'a push' })
  const have = await lifecycle.head?.() ?? null
  const bundle = await c.proposal.bundleSince(have)
  const bundlePath = path.join(root, `b-${Math.round(process.hrtime()[1])}.bundle`)
  fs.writeFileSync(bundlePath, bundle)
  return lifecycle.acceptBundle(bundlePath)
}

const prose = ['opening line', '', 'the middle nobody touches', '', 'closing line'].join('\n') + '\n'

// ---------------------------------------------------------------------------
// A shared starting point, from one checkout.

const a = checkout('a')
write(a, 'main.tex', prose)
write(a, 'figure.tex', 'a figure\n')
write(a, 'appendix.tex', 'an appendix\n')
const first = await propose(a, ['main.tex', 'figure.tex', 'appendix.tex'])
assert.equal(first.ok, true, `the first push is accepted: ${JSON.stringify(first).slice(0, 200)}`)

const store = createSourceGitStore({ gitDir: path.join(root, 'git') })
const headNow = async () => store.head(project)
const fileAt = async (rev, name) => (await store.readRevisionFile(rev, name))?.toString() ?? null

await adopt(a, await headNow())

// A second checkout that starts from the same base and then falls behind.
const b = checkout('b')
for (const f of ['main.tex', 'figure.tex', 'appendix.tex']) write(b, f, fs.readFileSync(path.join(a.dir, f), 'utf8'))
await adopt(b, await headNow())

// ---------------------------------------------------------------------------
// 1. Two people, different files. The loser must be REBASED, not refused.

write(a, 'figure.tex', 'a figure A edited\n')
const aWins = await propose(a, ['main.tex', 'figure.tex', 'appendix.tex'])
assert.equal(aWins.ok, true, 'the first of the two lands normally')

write(b, 'main.tex', prose.replace('closing line', 'closing line, as B revised it'))
const bLoses = await propose(b, ['main.tex', 'figure.tex', 'appendix.tex'])

assert.equal(bLoses.ok, true,
  `THE RULE: a push that lost a race on a DIFFERENT file is rebased, not refused — got ${JSON.stringify(bLoses).slice(0, 200)}`)
assert.equal(bLoses.status, 'accepted-clean-rebase', 'and it says that is what happened')

const head1 = await headNow()
assert.match(await fileAt(head1, 'main.tex'), /as B revised it/, "B's edit landed")
assert.equal(await fileAt(head1, 'figure.tex'), 'a figure A edited\n', "and A's edit was not clobbered by the rebase")

// ---------------------------------------------------------------------------
// 2. Same file, different lines. Still mechanical, still rebased.

await adopt(a, head1)
write(a, 'main.tex', await fileAt(head1, 'main.tex'))
write(b, 'main.tex', await fileAt(head1, 'main.tex'))

write(a, 'main.tex', (await fileAt(head1, 'main.tex')).replace('opening line', 'opening line, A'))
const aAgain = await propose(a, ['main.tex', 'figure.tex', 'appendix.tex'])
assert.equal(aAgain.ok, true, 'A lands on the top of the file')

write(b, 'main.tex', (await fileAt(head1, 'main.tex')).replace('the middle nobody touches', 'the middle, B'))
const bAgain = await propose(b, ['main.tex', 'figure.tex', 'appendix.tex'])
assert.equal(bAgain.ok, true,
  `two edits to different LINES of one file is mechanical — got ${JSON.stringify(bAgain).slice(0, 200)}`)

const head2 = await headNow()
const merged = await fileAt(head2, 'main.tex')
assert.match(merged, /opening line, A/, "A's line survived the server-side merge")
assert.match(merged, /the middle, B/, "and so did B's")
assert.ok(!merged.includes('<<<<<<<'), 'and it merged rather than leaving markers in his prose')

// ---------------------------------------------------------------------------
// 3. A DELETION that lost a race. Absence is removal, so this must rebase too.

await adopt(a, head2)
await adopt(b, head2)
for (const c of [a, b]) for (const f of ['main.tex', 'figure.tex', 'appendix.tex']) write(c, f, await fileAt(head2, f))

write(a, 'figure.tex', 'a figure A edited again\n')
assert.equal((await propose(a, ['main.tex', 'figure.tex', 'appendix.tex'])).ok, true, 'A lands first')

remove(b, 'appendix.tex')
const bDeletes = await propose(b, ['main.tex', 'figure.tex'])
assert.equal(bDeletes.ok, true,
  `A DELETION THAT LOST A RACE is still mechanical — got ${JSON.stringify(bDeletes).slice(0, 200)}`)

const head3 = await headNow()
const manifest3 = (await store.readManifest(head3)).map(e => e.path)
assert.ok(!manifest3.includes('appendix.tex'), 'the file B removed is gone from the rebased revision')
assert.equal(await fileAt(head3, 'figure.tex'), 'a figure A edited again\n', "and A's concurrent edit survived it")

// ---------------------------------------------------------------------------
// 4. THE SAME LINES. This one is a judgement, and only this one is refused.

await adopt(a, head3)
await adopt(b, head3)
for (const c of [a, b]) for (const f of ['main.tex', 'figure.tex']) write(c, f, await fileAt(head3, f))

write(a, 'main.tex', (await fileAt(head3, 'main.tex')).replace('closing line', 'closing line, A INSISTS'))
assert.equal((await propose(a, ['main.tex', 'figure.tex'])).ok, true, 'A takes the line')

write(b, 'main.tex', (await fileAt(head3, 'main.tex')).replace('closing line', 'closing line, B INSISTS'))
const collide = await propose(b, ['main.tex', 'figure.tex'])

assert.equal(collide.ok, false,
  'THE JUDGEMENT: two people changing the same lines is NOT mechanical and is not decided by the server')
assert.equal(collide.status, 'non-fast-forward', 'and it comes back as a refusal naming what it was refused against')
assert.ok(collide.refusedRevision, 'carrying the refused commit, so the work is never lost')

const head4 = await headNow()
assert.match(await fileAt(head4, 'main.tex'), /A INSISTS/,
  "the head still holds A's accepted text — a refused push changes nothing")

fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
console.log('a server that rebases instead of refusing: different files, different lines, and a deletion all land; only the same lines refuse')
process.exit(0)
