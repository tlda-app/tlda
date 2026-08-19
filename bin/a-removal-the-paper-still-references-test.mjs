#!/usr/bin/env node
//
// **§7.3: refuse a revision that removes a path the new tree still references.**
//
// The design's words: *"Refuse a revision in which a path that was in the
// previous tree is absent from the new tree while the new tree still references
// it."* This is what replaces wedging — a push that would leave the paper
// pointing at a file nobody holds is refused, whole, before anything is taken.
//
// **It is the SERVER's check, and that is the point.** It holds both trees and
// the referencing documents are in the tree, so it re-derives the closure rather
// than trusting a claim the daemon made about its own work. §7.5: a guard inside
// the component it guards is not a guard.
//
// The five rows of §7.3's table, and the third is the real save:
//
//   cut a section — \input and file both go        → accept, ordinary
//   git rm a retired figure nothing includes       → accept, ordinary
//   git rm a figure the paper still includes       → REFUSE, naming it
//   a crawler drops sec3.tex, body.tex \inputs it  → REFUSE, naming it
//   referenced and absent from BOTH trees          → accept — Skip's rule, a
//                                                    broken build, not a refusal
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { createSourceProposal } from '../daemon/source-proposal.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'removal-guard-'))
const project = 'paper'
const lifecycle = createSourceLifecycleStore({ root, project, context: { format: 'latex', mainFile: 'main.tex' } })
const store = createSourceGitStore({ gitDir: path.join(root, 'git') })

const dir = path.join(root, 'checkout')
fs.mkdirSync(dir, { recursive: true })
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'a'], ['config', 'user.email', 'a@test']]) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}
const proposal = createSourceProposal({ sourceDir: dir, project })

const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), text)
}
const remove = file => fs.rmSync(path.join(dir, file), { force: true })

async function push(members) {
  await proposal.proposeCommit({ members, message: 'a push' })
  const head = await store.head(project)
  const bundlePath = path.join(root, `b-${Math.round(process.hrtime()[1])}.bundle`)
  fs.writeFileSync(bundlePath, await proposal.bundleSince(head))
  const result = await lifecycle.acceptBundle(bundlePath)
  if (result.ok) {
    spawnSync('git', ['--git-dir', path.join(dir, '.git'), 'update-ref', 'refs/tlda/shadow/HEAD', await store.head(project)])
  }
  return result
}

// ---------------------------------------------------------------------------
// A paper that includes a section and a figure, and holds one file it does not
// reference at all.

write('main.tex', String.raw`
\documentclass{article}
\begin{document}
\input{sec3}
\includegraphics{figures/plot}
\end{document}
`)
write('sec3.tex', 'the third section\n')
write('figures/plot.pdf', '%PDF-fake')
write('retired.tex', 'nothing includes this\n')
const first = await push(['main.tex', 'sec3.tex', 'figures/plot.pdf', 'retired.tex'])
assert.equal(first.ok, true, `the starting revision is accepted: ${JSON.stringify(first).slice(0, 200)}`)
const base = await store.head(project)

// ---------------------------------------------------------------------------
// 1. A retired file nothing includes. Ordinary — this must NOT be refused, or
//    the guard makes deletion impossible, which is the feature it exists to
//    permit.

remove('retired.tex')
const retiring = await push(['main.tex', 'sec3.tex', 'figures/plot.pdf'])
assert.equal(retiring.ok, true,
  `ORDINARY: removing a file nothing references is accepted — got ${JSON.stringify(retiring).slice(0, 200)}`)
assert.ok(!(await store.readManifest(await store.head(project))).some(e => e.path === 'retired.tex'),
  'and it really left the paper')
const acceptedBeforeOrphan = await store.head(project)

// ---------------------------------------------------------------------------
// 2. THE REAL SAVE. The figure goes; the paper still \includegraphics it.

remove('figures/plot.pdf')
const orphaning = await push(['main.tex', 'sec3.tex'])

assert.equal(orphaning.ok, false,
  'THE GUARD: removing a figure the paper still includes is refused, not wedged')
assert.equal(orphaning.status, 'references-a-removed-path', 'and it says exactly what was wrong')
assert.deepEqual(orphaning.removedButReferenced, ['figures/plot.pdf'],
  'NAMING IT: the author is told which path, not that something is wrong')
assert.ok(orphaning.refusedRevision, 'the refused commit is kept, so the work is not lost')
assert.equal(orphaning.revision, acceptedBeforeOrphan,
  'SELF-HEALING: the refusal names the accepted head so the checkout can rebuild its proposal on the complete tree')
assert.equal(await store.head(project), base === undefined ? undefined : await store.head(project),
  'sanity: the head is readable')
assert.ok((await store.readManifest(await store.head(project))).some(e => e.path === 'figures/plot.pdf'),
  'and the head still holds the figure — a refused push changes nothing')

// **Damped, not surfaced.** A settle window can split an ordinary two-step edit
// — delete the file, remove the \includegraphics four seconds later — so this
// refusal must not reach the author on its own. It surfaces only if the next
// settle reproduces it. An alarm that fires constantly and an alarm that never
// clears are the same alarm.
assert.equal(orphaning.damped, true,
  'DAMPED: the refusal is marked so the daemon does not surface a two-step edit as an error')

// ---------------------------------------------------------------------------
// 3. The two-step edit completing. Remove the reference too, and it accepts —
//    which is what makes the damping correct rather than a way of hiding it.

fs.writeFileSync(path.join(dir, 'main.tex'),
  fs.readFileSync(path.join(dir, 'main.tex'), 'utf8').replace(/\\includegraphics\{figures\/plot\}\n/, ''))
const settled = await push(['main.tex', 'sec3.tex'])
assert.equal(settled.ok, true,
  `SELF-HEALING: once the reference goes too, the same removal is ordinary — got ${JSON.stringify(settled).slice(0, 200)}`)
assert.ok(!(await store.readManifest(await store.head(project))).some(e => e.path === 'figures/plot.pdf'),
  'and the figure is gone from the paper')

// ---------------------------------------------------------------------------
// 4. A crawler drops a section body.tex still \inputs. Refused, by the same rule
//    reached through a different file — the closure is transitive, so a
//    reference two levels down counts.

write('body.tex', String.raw`\input{deep}`)
write('deep.tex', 'two levels down\n')
fs.writeFileSync(path.join(dir, 'main.tex'),
  fs.readFileSync(path.join(dir, 'main.tex'), 'utf8').replace('\\input{sec3}', '\\input{sec3}\n\\input{body}'))
assert.equal((await push(['main.tex', 'sec3.tex', 'body.tex', 'deep.tex'])).ok, true, 'the deeper structure lands')

remove('deep.tex')
const deepLoss = await push(['main.tex', 'sec3.tex', 'body.tex'])
assert.equal(deepLoss.ok, false, 'TRANSITIVE: a file referenced two levels down is still a member')
assert.deepEqual(deepLoss.removedButReferenced, ['deep.tex'], 'and it is named')

// ---------------------------------------------------------------------------
// 5. Referenced and absent from BOTH trees. Skip's rule: a broken build, not a
//    refusal. The guard is about a CHANGE, so a file that never existed is not
//    its business.

fs.writeFileSync(path.join(dir, 'main.tex'),
  fs.readFileSync(path.join(dir, 'main.tex'), 'utf8').replace('\\input{body}', '\\input{body}\n\\input{never-existed}'))
write('deep.tex', 'two levels down\n')
const neverExisted = await push(['main.tex', 'sec3.tex', 'body.tex', 'deep.tex'])
assert.equal(neverExisted.ok, true,
  `NEVER EXISTED: a reference to a file absent from both trees is a broken build, not a refusal — got ${JSON.stringify(neverExisted).slice(0, 200)}`)

fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
console.log('a removal the paper still references: retired files leave, referenced ones are refused and named, and a two-step edit self-heals')
process.exit(0)
