#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'
import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { createSourceProposal } from '../daemon/source-proposal.mjs'
import { createSourcePush } from '../daemon/source-push.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'referenced-removal-rebase-'))
const project = 'fixture'
const checkout = path.join(root, 'checkout')
fs.mkdirSync(checkout, { recursive: true })
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'fixture'], ['config', 'user.email', 'fixture@test']]) {
  const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

const mainPath = path.join(checkout, 'main.tex')
fs.writeFileSync(mainPath, String.raw`\documentclass{article}
\addbibresource{refs.bib}
\begin{document}
fixture
\end{document}
`)
fs.writeFileSync(path.join(checkout, 'refs.bib'), '@book{fixture, title={Fixture}}\n')

const lifecycle = createSourceLifecycleStore({ root: path.join(root, 'server'), project, context: { format: 'latex', mainFile: 'main.tex' } })
const serverStore = createSourceGitStore({ gitDir: path.join(root, 'server', 'git') })
const proposal = createSourceProposal({ sourceDir: checkout, project })

async function offerCurrentProposal() {
  const bundlePath = path.join(root, `offer-${Date.now()}-${Math.random()}.bundle`)
  fs.writeFileSync(bundlePath, await proposal.bundleSince(await serverStore.head(project)))
  return lifecycle.acceptBundle(bundlePath)
}

await proposal.proposeCommit({ members: ['main.tex', 'refs.bib'], message: 'accepted fixture' })
const accepted = await offerCurrentProposal()
assert.equal(accepted.ok, true, 'the complete fixture tree is accepted')
const acceptedHead = await serverStore.head(project)
spawnSync('git', ['--git-dir', path.join(checkout, '.git'), 'update-ref', 'refs/tlda/shadow/HEAD', acceptedHead])

await proposal.proposeCommit({ members: ['main.tex'], message: 'refused incomplete tree' })
const refused = await offerCurrentProposal()
assert.equal(refused.status, 'references-a-removed-path', 'the incomplete tree reaches the reference guard')
assert.equal(refused.revision, acceptedHead, 'the refusal names the accepted head')

fs.appendFileSync(mainPath, '% saved edit\n')
const pusher = createSourcePush({
  proposal,
  project,
  server: 'https://fixture.invalid',
  fetchImpl: async (_url, options = {}) => {
    const bundlePath = path.join(root, `push-${Date.now()}-${Math.random()}.bundle`)
    fs.writeFileSync(bundlePath, Buffer.from(options.body))
    const result = await lifecycle.acceptBundle(bundlePath)
    if (!result.ok) {
      return new Response(JSON.stringify({
        ok: false,
        status: result.status,
        currentRevision: result.revision ?? null,
        refusedRevision: result.refusedRevision ?? null,
      }), { status: 409, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ ok: true, sourceRevision: result.revision.id }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  },
})

const recovered = await pusher.push({ changed: ['main.tex'], deleted: [] })
assert.equal(recovered.ok, true, `the next save recovers: ${JSON.stringify(recovered)}`)
assert.equal(recovered.attempts, 2, 'the first incomplete proposal is refused and the accepted-head proposal lands')
assert.deepEqual(
  (await serverStore.readManifest(await serverStore.head(project))).map(entry => entry.path),
  ['main.tex', 'refs.bib'],
  'the recovered revision keeps the referenced bibliography',
)

fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
console.log('a referenced removal rebases over HTTP: the refusal names the accepted head and the next proposal keeps the bibliography')
