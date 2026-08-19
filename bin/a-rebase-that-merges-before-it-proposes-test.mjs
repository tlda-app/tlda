#!/usr/bin/env node
//
// **A complete tree makes every member's bytes come from the working copy — so
// a rebase that does not bring the working copy forward is a clobber.**
//
// This is the test for the step that stops it, and for the one clause of that
// step which is a refusal rather than a computation.
//
// Under the retired tree-over-parent form, a re-proposal carried only the paths
// we touched, so a file we were behind on kept whatever the server had. Under a
// complete tree there is no such thing as a path we are not sending: absence
// from the tree IS deletion, so the rebase hands back OUR copy of THEIR file.
// Their accepted paragraph is overwritten with no error, no refusal and no
// marker — the exact failure the refusal path exists to prevent, arriving
// through it.
//
// Four cases, and the fourth is the one that gets dropped:
//
//   1. Only they moved it            → their bytes are taken into the checkout
//   2. Both moved it, different lines → merged, and BOTH changes survive
//   3. Only they deleted it           → it leaves the checkout and the proposal
//   4. Both moved the SAME lines      → **conflicted, and the settle loop HOLDS**
//
// **Case 4 is the whole guarantee.** A merge that resolves what it can and
// re-proposes anyway is the clobber again with more steps: it picks a side
// silently. So what is asserted is not that a marker appeared — it is that
// nothing was proposed, and that the server's head still holds their words.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { spawnSync } from 'node:child_process'
import { createSourceProposal } from '../daemon/source-proposal.mjs'
import { createSourcePush } from '../daemon/source-push.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rebase-merge-'))
const serverGit = path.join(root, 'server.git')
const checkout = path.join(root, 'checkout')
const project = 'paper'
spawnSync('git', ['init', '--bare', '--quiet', serverGit])
fs.mkdirSync(checkout, { recursive: true })
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'the author'], ['config', 'user.email', 'a@example.test']]) {
  const r = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}

const store = createSourceGitStore({ gitDir: serverGit })
const app = express()
app.post('/api/projects/:name/source-bundle', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const bundlePath = path.join(root, `proposed-${Date.now()}-${Math.round(process.hrtime()[1])}.bundle`)
  fs.writeFileSync(bundlePath, req.body)
  try {
    const proposed = await store.ingestBundle(project, bundlePath)
    if (!proposed) return res.status(400).json({ ok: false, error: 'empty bundle' })
    const result = await store.fastForward(project, proposed)
    if (!result.ok) {
      await store.markRefused(project, proposed, await store.refused(project))
      return res.status(409).json({ ok: false, status: result.status, currentRevision: result.revision, refusedRevision: proposed })
    }
    res.json({ ok: true, status: result.status, sourceRevision: result.revision })
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message })
  }
})
app.get('/api/projects/:name/source-bundle', async (req, res) => {
  const head = await store.head(project)
  if (!head) return res.status(404).json({ ok: false, error: 'no accepted revision' })
  res.json({
    ok: true,
    currentRevision: head,
    bundleBase64: await store.bundleSince(project, head, { includeRefused: true, have: req.query.have || null }),
  })
})
const listening = await new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server))
})
const origin = `http://127.0.0.1:${listening.address().port}`

const proposal = createSourceProposal({ sourceDir: checkout, project })
const pusher = createSourcePush({ proposal, project, server: origin, token: null })
const write = (name, text) => fs.writeFileSync(path.join(checkout, name), text)
const read = name => fs.readFileSync(path.join(checkout, name), 'utf8')
const onServer = async (revision, name) => (await store.readRevisionFile(revision, name)).toString()

// A paragraph with room on both sides of it, so that two people can edit the
// same file without editing the same lines — which is the ordinary case and the
// one a merge is for.
const prose = ['opening line', '', 'the middle, which nobody touches', '', 'closing line'].join('\n') + '\n'

// ---------------------------------------------------------------------------
// The shared starting point.

write('main.tex', prose)
write('figure.tex', 'a figure nobody is editing\n')
write('appendix.tex', 'an appendix that is about to be cut\n')
const first = await pusher.push({ changed: ['main.tex', 'figure.tex', 'appendix.tex'] })
assert.equal(first.ok, true, 'the starting revision is accepted')

// ---------------------------------------------------------------------------
// Somebody else lands three things at once: an edit to a file we never touch,
// an edit to the TOP of a file we are editing the BOTTOM of, and a deletion.

const theirProse = prose.replace('opening line', 'opening line, as THEY revised it')
const theirs = await store.acceptRevision({
  project,
  parent: await store.head(project),
  message: 'somebody else, on the server',
  files: [
    { path: 'main.tex', content: theirProse },
    { path: 'figure.tex', content: 'a figure THEY edited\n' },
  ],
})
await store.advanceHead(project, theirs, first.sourceRevision)

// Our own work, in the same window: the bottom of main.tex only.
write('main.tex', prose.replace('closing line', 'closing line, as WE revised it'))
const contended = await pusher.push({ changed: ['main.tex'] })
assert.equal(contended.ok, true, `the refusal was recovered from (${contended.status || 'accepted'})`)

// 1. Only they moved it. Ours was stale; theirs is what the paper says.
assert.equal(await onServer(contended.sourceRevision, 'figure.tex'), 'a figure THEY edited\n',
  'THE CLOBBER TEST: a file only they touched survives our complete-tree re-proposal')
assert.equal(read('figure.tex'), 'a figure THEY edited\n',
  'and their bytes were written into OUR checkout, which is what made the re-proposal safe')

// 2. Both moved it, in different places. Neither edit is chosen over the other.
const mergedText = await onServer(contended.sourceRevision, 'main.tex')
assert.ok(mergedText.includes('opening line, as THEY revised it'), 'their edit survived the merge')
assert.ok(mergedText.includes('closing line, as WE revised it'), 'and so did ours')
assert.ok(!mergedText.includes('<<<<<<<'), 'and it merged rather than conflicting')

// 3. Only they deleted it. A path absent from their tree is not a member.
assert.equal(fs.existsSync(path.join(checkout, 'appendix.tex')), false,
  'a file they deleted left our checkout too')
assert.equal((await store.readManifest(contended.sourceRevision)).map(e => e.path).includes('appendix.tex'), false,
  'and our re-proposal did not resurrect it')

// ---------------------------------------------------------------------------
// 4. **THE HOLD.** Both of us edit the same line.

const headBefore = await store.head(project)
const theirWord = await store.acceptRevision({
  project,
  parent: headBefore,
  message: 'they take the closing line',
  files: [
    { path: 'main.tex', content: mergedText.replace('closing line, as WE revised it', 'closing line, THEIR final word') },
    { path: 'figure.tex', content: 'a figure THEY edited\n' },
  ],
})
await store.advanceHead(project, theirWord, headBefore)

write('main.tex', mergedText.replace('closing line, as WE revised it', 'closing line, OUR final word'))
const stuck = await pusher.push({ changed: ['main.tex'] })

assert.equal(stuck.ok, false, 'THE HOLD: a real disagreement is not resolved by proposing anyway')
assert.equal(stuck.status, 'conflicted', 'and it is reported as a conflict rather than a transport failure')
assert.deepEqual(stuck.conflicted.map(item => item.path), ['main.tex'],
  'naming the path a person has to look at')

// **The assertion that carries the guarantee.** Not that a marker appeared —
// that nothing was proposed, so their word is still what the paper says.
assert.equal(await store.head(project), theirWord,
  'THE HOLD, on the server: the head did not move, because nothing was proposed over it')
assert.equal(await onServer(theirWord, 'main.tex'), (await onServer(theirWord, 'main.tex')),
  'sanity: the head is readable')
assert.ok((await onServer(await store.head(project), 'main.tex')).includes('closing line, THEIR final word'),
  'and their words are the ones still standing')

// The markers are in the checkout, because the person who resolves this is the
// person editing this checkout, and they resolve it in the file.
const conflictedText = read('main.tex')
assert.ok(conflictedText.includes('<<<<<<<') && conflictedText.includes('>>>>>>>'),
  'the conflict is written down where the person editing can see it')
assert.ok(conflictedText.includes('THEIR final word') && conflictedText.includes('OUR final word'),
  'with both sides present, so neither was silently discarded')
assert.ok(!conflictedText.includes(os.tmpdir()),
  'and the markers name the sides rather than a temp path nobody can read')

listening.close()
fs.rmSync(root, { recursive: true, force: true })
console.log('a rebase that merges before it proposes: theirs taken, both edits merged, deletion carried, and a real conflict HELD')
process.exit(0)
