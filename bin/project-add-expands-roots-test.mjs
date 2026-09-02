#!/usr/bin/env node
/**
 * `tlda project add` puts a file into a project WITHOUT reseeding it.
 *
 * Skip, 2026-09-02 02:28:21 EDT: *"do we not need an add when we want to like,
 * pull a new file from main into our tlda project?"*, and on the shape of it:
 * *"i mean it's effectively unlink and link with a new set of roots yes?"*
 * (02:28:59), *"like an unlink link hack is fine"* (02:38:14).
 *
 * WHAT THIS HAS TO CATCH, and it is the whole reason the test exists rather
 * than a unit test of the append: an unlink/link implementation reaches the
 * same declared root set and destroys the thing the command is for. The
 * project's tlda branch and its history are what `tlda project merge` maps back
 * out; a relink re-runs the history seed. So the assertions are not only "the
 * root is declared" — they are that `refs/heads/tlda/<project>` is at the SAME
 * commit with the SAME ancestry afterwards, and that the daemon was never asked
 * to unlink anything.
 *
 * REAL EVERYTHING. The express router from server/routes/projects.mjs is
 * mounted and listening, the project store is initialised the way a server
 * initialises it, the checkout is a real git repository with a real
 * `tlda/<project>` branch, a socket answers the daemon lifecycle protocol at
 * the path the CLI computes, and the CLI is the real binary as a subprocess.
 * Calling the append helper directly would prove the append and nothing about
 * whether the command reaches it.
 *
 * Run: node bin/project-add-expands-roots-test.mjs
 */

import express from 'express'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { daemonLifecycleSocketPath, daemonStateSuffix } from '../shared/daemon-socket-path.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = resolve(HERE, '../cli/tlda.mjs')
const ENV_NAME = 'add-proof'

// realpath, because `inferProjectName` compares `resolve('.')` in the CHILD —
// which is `process.cwd()`, already symlink-free — against the path in the
// binding file. On macOS `mkdtemp` hands back `/var/folders/…` and the child
// reports `/private/var/folders/…`, so a rig that writes the un-resolved path
// records the checkout as bound to a directory nothing matches, and every story
// reports `project add` as unable to infer the project.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tlda-project-add-')))
const home = join(root, 'home')
const config = join(home, '.config', 'tlda')
const projectsDir = join(root, 'projects')
const authorRepo = join(root, 'author')
const projectName = 'a-throwaway-project'
mkdirSync(config, { recursive: true })
mkdirSync(projectsDir, { recursive: true })

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

// The author's repository, with the branch layout a linked checkout has: their
// own `main`, and the daemon-managed `tlda/<project>` they stand on.
mkdirSync(authorRepo, { recursive: true })
git(authorRepo, 'init', '-q', '-b', 'main')
git(authorRepo, 'config', 'user.email', 'test@local')
git(authorRepo, 'config', 'user.name', 'Test')
writeFileSync(join(authorRepo, 'main.tex'), '\\documentclass{article}\\begin{document}One\\end{document}\n')
git(authorRepo, 'add', 'main.tex')
git(authorRepo, 'commit', '-qm', 'Start the paper')
// A file that exists only on `main` — the "pull a new file from main" case.
writeFileSync(join(authorRepo, 'notes.md'), '# Notes\n')
git(authorRepo, 'add', 'notes.md')
git(authorRepo, 'commit', '-qm', 'Add notes on main')
git(authorRepo, 'branch', 'tlda/a-throwaway-project', 'HEAD~1')
git(authorRepo, 'checkout', '-q', 'tlda/a-throwaway-project')

const branchTipBefore = git(authorRepo, 'rev-parse', 'refs/heads/tlda/a-throwaway-project')
const branchLogBefore = git(authorRepo, 'log', '--format=%H %s', 'refs/heads/tlda/a-throwaway-project')

const { initProjectStore, closeProjectStore } = await import('../server/lib/project-store.mjs')
await initProjectStore(projectsDir)
const projectRoutes = (await import('../server/routes/projects.mjs')).default

// Every write the CLI makes to the record goes through the real router, and
// this counts them, because "is it idempotent" is a question about whether a
// second run WRITES — not about what the record looks like afterwards.
let documentRootPatches = 0
const app = express()
app.use(express.json({ limit: '10mb' }))
app.use((req, _res, next) => {
  if (req.method === 'PATCH' && /\/document-roots$/.test(req.path)) documentRootPatches++
  next()
})
app.use('/api/projects', projectRoutes)
const server = await new Promise(res => {
  const s = app.listen(0, '127.0.0.1', () => res(s))
})
const serverUrl = `http://127.0.0.1:${server.address().port}`

const created = await fetch(`${serverUrl}/api/projects`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: projectName,
    title: 'A throwaway project',
    mainFile: 'main.tex',
    documentRoots: [{ path: 'main.tex', format: 'svg' }],
  }),
})
if (!created.ok) {
  // A rig that could not create the project would report every story below as a
  // defect in `project add`. Fail on the setup instead, saying what the server
  // said, so the two are never confused.
  console.error(`setup: could not create the project (${created.status}): ${await created.text()}`)
  process.exit(1)
}

// The daemon. It records every op it is asked for, which is how "it never
// unlinks" is checked against what the command actually did rather than
// against a reading of the source.
const daemonOps = []
const socketPath = daemonLifecycleSocketPath(config, ENV_NAME)
const daemon = createNetServer({ allowHalfOpen: true }, socket => {
  let raw = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => { raw += chunk })
  socket.on('end', () => {
    let request = {}
    try { request = JSON.parse(raw) } catch { /* recorded below as an unparseable op */ }
    daemonOps.push({ op: request.op || null, params: request.params || {} })
    socket.end(`${JSON.stringify({ ok: true, result: { ok: true, submission: { revision: 'a'.repeat(40), dropped: [] } } })}\n`)
  })
})
await new Promise(res => daemon.listen(socketPath, res))

// The environment has to be DECLARED, not merely named: `getActiveEnvName`
// resolves through `resolveStrictEnvironmentAuthority`, so an undeclared
// `TLDA_ENV` does not select an environment and the CLI computes the default
// suffix — which puts the binding file and the daemon socket at paths it never
// looks at, and the command reports the checkout as unlinked.
writeFileSync(join(config, 'server.yaml'), '')
writeFileSync(
  join(config, 'daemon.yaml'),
  `machineId: ${hostname().split('.')[0]}\nenvironments:\n  default: ${ENV_NAME}\n  values:\n    ${ENV_NAME}:\n      database: ${serverUrl}\n      store: ${serverUrl}\n      licenseKey: ""\n`,
)

// The binding file `inferProjectName` reads, so the first story can run with no
// `--project` at all — which is how a person in their own checkout runs it.
writeFileSync(
  join(config, `source-bindings${daemonStateSuffix(ENV_NAME)}.json`),
  JSON.stringify({ [projectName]: { sourceDir: authorRepo, bindingId: 'binding-1', documentRoots: ['main.tex'] } }),
)

function runCli(argv, cwd = authorRepo) {
  return new Promise(res => {
    const child = spawn(process.execPath, [CLI, ...argv, '--server', serverUrl], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        TLDA_CONFIG_DIR: config,
        TLDA_DAEMON_CONFIG_DIR: config,
        TLDA_ENV: ENV_NAME,
        TLDA_TOKEN: 'test-token',
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', status => res({ status, stdout, stderr }))
  })
}

async function roots() {
  const answer = await fetch(`${serverUrl}/api/projects/${projectName}`).then(r => r.json())
  return ((answer?.project || answer)?.documentRoots || []).map(r => `${r.path}:${r.format}`)
}

const tracked = () => git(authorRepo, 'ls-files').split('\n').filter(Boolean)

let failures = 0
function ok(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); return }
  failures++
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

try {
  console.log('\na new file in the checkout becomes a document root')
  writeFileSync(join(authorRepo, 'appendix.tex'), '\\section{Appendix}\n')
  const added = await runCli(['project', 'add', 'appendix.tex'])
  ok('the CLI succeeds', added.status === 0, `exit ${added.status}\n${added.stdout}\n${added.stderr}`)
  ok('it says what it added', /Added appendix\.tex/.test(added.stdout), added.stdout)
  ok('the project declares both roots, the existing one first',
    (await roots()).join(', ') === 'main.tex:svg, appendix.tex:svg', (await roots()).join(', '))
  ok('the untracked file was staged', tracked().includes('appendix.tex'), tracked().join(' '))
  ok('it said so', /staged appendix\.tex/.test(added.stdout), added.stdout)
  ok('it submitted through the daemon', /Submitted/.test(added.stdout), added.stdout)

  console.log('\nthe project keeps the branch and history it already had')
  ok('the tlda branch is at the same commit',
    git(authorRepo, 'rev-parse', 'refs/heads/tlda/a-throwaway-project') === branchTipBefore)
  ok('its history is unchanged, commit for commit',
    git(authorRepo, 'log', '--format=%H %s', 'refs/heads/tlda/a-throwaway-project') === branchLogBefore)
  ok('nothing was unlinked',
    !daemonOps.some(op => op.op === 'project-source-unlink'),
    JSON.stringify(daemonOps.map(o => o.op)))
  ok('the daemon was asked for the same checkout it already had',
    daemonOps.every(op => !op.params.sourceDir || op.params.sourceDir === authorRepo),
    JSON.stringify(daemonOps.map(o => o.params.sourceDir)))
  ok('no history seed was requested',
    daemonOps.every(op => op.params.seedRevision == null && op.params.seedBranch == null),
    JSON.stringify(daemonOps.map(o => ({ b: o.params.seedBranch, r: o.params.seedRevision }))))

  console.log('\nrunning it again adds nothing')
  const patchesAfterFirst = documentRootPatches
  const again = await runCli(['project', 'add', 'appendix.tex', '--project', projectName])
  ok('the second run succeeds', again.status === 0, `${again.stdout}\n${again.stderr}`)
  ok('it says the file is already a root', /already a document root/.test(again.stdout), again.stdout)
  ok('it wrote nothing to the record', documentRootPatches === patchesAfterFirst,
    `${documentRootPatches} patches, expected ${patchesAfterFirst}`)
  ok('the roots are unchanged',
    (await roots()).join(', ') === 'main.tex:svg, appendix.tex:svg', (await roots()).join(', '))

  console.log('\n--from pulls a file that is only on another branch')
  const beforeFrom = await roots()
  const pulled = await runCli(['project', 'add', 'notes.md', '--from', 'main', '--project', projectName])
  ok('the CLI succeeds', pulled.status === 0, `exit ${pulled.status}\n${pulled.stdout}\n${pulled.stderr}`)
  ok('it says where it took the file from', /took notes\.md from main/.test(pulled.stdout), pulled.stdout)
  ok('the file is in the working tree and tracked', tracked().includes('notes.md'), tracked().join(' '))
  ok('it is a root, with the format the FILE says, not the project\'s',
    (await roots()).join(', ') === `${beforeFrom.join(', ')}, notes.md:markdown`, (await roots()).join(', '))
  ok('the tlda branch still has not moved',
    git(authorRepo, 'rev-parse', 'refs/heads/tlda/a-throwaway-project') === branchTipBefore)

  console.log('\nwhat it refuses')
  const patchesBeforeRefusals = documentRootPatches
  writeFileSync(join(authorRepo, 'figure.png'), 'not really a png')
  const notADocument = await runCli(['project', 'add', 'figure.png', '--project', projectName])
  ok('a non-document is refused', notADocument.status !== 0, notADocument.stdout)
  ok('it says why', /is not a document/.test(notADocument.stderr), notADocument.stderr)

  const missing = await runCli(['project', 'add', 'nowhere.tex', '--project', projectName])
  ok('a file that is not here is refused', missing.status !== 0)
  ok('it names --from as the way to take it from another branch',
    /--from <branch>/.test(missing.stderr), missing.stderr)

  const clobber = await runCli(['project', 'add', 'notes.md', '--from', 'main', '--project', projectName])
  ok('--from over a file that is already here is refused', clobber.status !== 0)
  ok('it says it would overwrite', /would overwrite/.test(clobber.stderr), clobber.stderr)

  const outside = await runCli(['project', 'add', '../outside.tex', '--project', projectName])
  ok('a path outside the working copy is refused', outside.status !== 0)
  ok('it says why', /outside/.test(outside.stderr), outside.stderr)

  ok('no refusal wrote to the record', documentRootPatches === patchesBeforeRefusals,
    `${documentRootPatches} patches, expected ${patchesBeforeRefusals}`)
  ok('and none of them unlinked anything',
    !daemonOps.some(op => op.op === 'project-source-unlink'),
    JSON.stringify(daemonOps.map(o => o.op)))
} finally {
  await new Promise(res => server.close(res))
  await new Promise(res => daemon.close(res))
  await closeProjectStore().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nPASS project add expands roots')
process.exit(failures ? 1 : 0)
