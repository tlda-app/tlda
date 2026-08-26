/**
 * **Relinking a LaTeX project that declares no document roots must not declare one.**
 *
 * This is the same requirement `shared/document-roots-to-declare.test.mjs`
 * already states — and that test passes while the behaviour is broken, which is
 * the whole reason this file exists.
 *
 * **What the unit test cannot see.** `documentRootsToDeclare` is correct in
 * isolation. The CLI hands it input that has ALREADY been invented:
 * `cli/tlda.mjs` builds `projectDocumentRoots` with
 * `normalizeDocumentRoots(documentRoots, { mainFile, format })`, and
 *
 *     normalizeDocumentRoots([], { mainFile: 'main.tex', format: 'svg' })
 *       -> [{ path: 'main.tex', format: 'svg' }]
 *
 * synthesises a root from the main file when the list is empty. The guard then
 * receives that as `supplied` and correctly passes it through. Right function,
 * wrong input — so the check has to run against the real CLI and a real record.
 *
 * **And why LaTeX specifically.** The markdown branch never PATCHes
 * document-roots at all: on already-exists it logs and pushes. Only the
 * LaTeX/svg branch PATCHes. A sweep of six markdown projects and one LaTeX one
 * passed six times and then wrote `main.tex` onto the seventh — the six proved
 * nothing about this path, because they never reached it.
 *
 * Measured 2026-08-26 on a real project: `absent -> [{"path":"main.tex",
 * "format":"svg"}]`, and the API cannot put it back — `PATCH
 * /document-roots {documentRoots: []}` answers `400 documentRoots must be a
 * non-empty array`. **The state is reachable and not settable**, which is what
 * makes this worth an end-to-end gate rather than a note.
 */
import assert from 'node:assert/strict'
import { execFile as execFileCb, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test, { after, before } from 'node:test'

import { startServer, stopServer, unusedPort } from '../server/lib/unified-server-test-harness.mjs'

const execFile = promisify(execFileCb)
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'tlda.mjs')
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8' })

/**
 * Run the real CLI until it prints a stage, then stop it.
 *
 * The relink continues into a push through the daemon's Git remote and this
 * harness has no daemon behind it, so the command would sit until its own
 * timeout. The markers cover BOTH environments deliberately — with a daemon it
 * reaches the push, without one it says the daemon is unavailable — so the run
 * is not a fact about whether this machine happens to run a daemon.
 */
function cliUntil(cwd, args, base, until, capMs = 45_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--server', base], {
      cwd, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', GIT_SSL_NO_VERIFY: '1' },
    })
    let out = ''
    let matched = null
    let settled = false
    const finish = (reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {
        // Already exited on every path but the reached-the-stage one, and
        // failing to kill a dead process is not a test failure.
      }
      resolve({ out, reason, matched })
    }
    const timer = setTimeout(() => finish('timeout'), capMs)
    const watch = chunk => {
      out += String(chunk)
      const hit = out.match(until)
      if (hit) { matched = hit[0]; finish('reached-stage') }
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('close', () => finish('exited'))
  })
}

let server = null
let base = ''
let root = ''
let previousTls

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'tlda-latex-relink-'))
  const port = await unusedPort()
  base = `https://127.0.0.1:${port}`
  previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  server = await startServer({ port, projectsDir: join(root, 'projects'), fleetDb: join(root, 'fleet.db') })
})

after(async () => {
  if (server) await stopServer(server)
  if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
  rmSync(root, { recursive: true, force: true })
})

const rootsOf = record => {
  const project = record?.project || record
  if (!('documentRoots' in project)) return { shape: 'absent', roots: [] }
  const roots = project.documentRoots || []
  return { shape: roots.length ? `set:${roots.length}` : 'empty', roots }
}

/**
 * A LaTeX project that declares NOTHING.
 *
 * Created WITHOUT a mainFile, and that is the only way to reach this state --
 * measured against the real server: creating with `mainFile: 'main.tex'`
 * declares `main.tex` immediately, and passing `documentRoots: []` explicitly
 * alongside a mainFile is overridden rather than honoured. There is also no way
 * back: `PATCH /document-roots` answers 400 for both `[]` and `null`
 * ("documentRoots must be a non-empty array").
 *
 * So the rootless state is REACHABLE AND NOT SETTABLE, which is exactly why a
 * relink must not spend it.
 */
async function latexProjectDeclaringNothing(name, { mainFile = null } = {}) {
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, title: name, format: 'svg', ...(mainFile ? { mainFile } : {}) }),
  })
  assert.equal(created.status, 201, await created.text())

  const checkout = join(root, name)
  mkdirSync(checkout)
  await git(checkout, ['init', '-b', 'main'])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), '\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])
  return checkout
}

test('relinking a LaTeX project that declares no roots still declares none', async () => {
  const name = 'latex-rootless'
  const checkout = await latexProjectDeclaringNothing(name)

  const before = rootsOf(await (await fetch(`${base}/api/projects/${name}`)).json())
  assert.deepEqual(before.roots, [], `the fixture really declares nothing (saw ${before.shape})`)

  // THE RELINK: no source, no roots — the repair path.
  const relink = await cliUntil(checkout, ['project', 'link', name], base,
    /Usage: tlda project link|local fleet daemon is unavailable|exists, pushing files|Submitting |Submitted /)
  assert.equal(relink.reason, 'reached-stage',
    `the CLI reached a known stage rather than dying quietly:\n${relink.out}`)
  assert.doesNotMatch(relink.matched, /Usage: tlda project link/,
    `and got past argument handling:\n${relink.out}`)

  const after = rootsOf(await (await fetch(`${base}/api/projects/${name}`)).json())
  assert.deepEqual(after.roots, [],
    `THE BUG: relinking declared ${JSON.stringify(after.roots)} on the project's behalf. ` +
    `A repair that invents a declaration is worse than the state it repaired, and on a real ` +
    `project this is not revertible — the API refuses an empty documentRoots array.\n${relink.out}`)
})

test('relinking a LaTeX project that HAS roots keeps exactly those', async () => {
  // The other half, and it is what stops the repair from becoming "never write
  // roots". A project that declares something must still declare it afterwards,
  // or the fix trades an invention for a deletion.
  const name = 'latex-declared'
  const checkout = await latexProjectDeclaringNothing(name, { mainFile: 'main.tex' })
  writeFileSync(join(checkout, 'chapter.tex'), 'chapter\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'chapter'])

  // The declaration must include the project's mainFile -- the server rejects
  // one that does not ("documentRoots must include the project mainFile"), so a
  // chapter-only declaration is not a state this project can be in.
  const set = await fetch(`${base}/api/projects/${name}/document-roots`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentRoots: [{ path: 'main.tex', format: 'svg' }, { path: 'chapter.tex', format: 'svg' }] }),
  })
  assert.equal(set.status, 200, await set.text())

  const relink = await cliUntil(checkout, ['project', 'link', name], base,
    /Usage: tlda project link|local fleet daemon is unavailable|exists, pushing files|Submitting |Submitted /)
  assert.equal(relink.reason, 'reached-stage', `the CLI reached a known stage:\n${relink.out}`)

  const after = rootsOf(await (await fetch(`${base}/api/projects/${name}`)).json())
  assert.deepEqual(after.roots.map(entry => entry.path ?? entry), ['main.tex', 'chapter.tex'],
    `the existing declaration survives the relink unchanged:\n${relink.out}`)
})
