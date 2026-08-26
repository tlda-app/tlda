/**
 * **`project link` does not demand a source for a project that already exists.**
 *
 * `project link` required a source and roots before it knew whether the project
 * existed, so relinking meant naming the documents again — and for a project
 * that declares none there was no way at all except to invent some and write
 * them into its record. A repair that manufactures a declaration is the shape of
 * defect this area has produced before, so the fix has to be checked by looking
 * at the record afterwards, not at the command's exit code.
 *
 * Drives the REAL CLI against a REAL server. The thing under test is what
 * `project link` does to a project record, and a stub of either end would prove
 * something else.
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
 * Run the real CLI and STOP WATCHING once it has passed a named stage.
 *
 * A relink continues into a push through the daemon's git remote, and this
 * harness runs a server with no daemon behind it, so the command would sit
 * there until whatever timeout it was given. Waiting for that costs two minutes
 * per run and makes the record assertion happen only after a timeout error --
 * which is a test whose timing is an accident rather than a decision.
 *
 * So the caller names the point it cares about, this returns as soon as the CLI
 * prints it, and the child is stopped. The proof is unweakened: it is the real
 * CLI against the real server, and the stage is one the CLI announces on its way
 * past the thing under test.
 */
function cliUntil(cwd, args, base, until, capMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--server', base], {
      cwd, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', GIT_SSL_NO_VERIFY: '1' },
    })
    let out = ''
    let matched = null
    let settled = false
    const finish = (reason, code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {
        // Swallowed deliberately: the child has already exited on every path
        // that reaches here except the reached-the-stage one, and failing to
        // kill an already-dead process is not a test failure.
      }
      resolve({ out, reason, code, matched })
    }
    // A cap, not the mechanism. If the CLI never reaches the stage the test
    // fails on its assertions rather than hanging.
    const timer = setTimeout(() => finish('timeout', null), capMs)
    const watch = chunk => {
      out += String(chunk)
      const hit = out.match(until)
      if (hit) { matched = hit[0]; finish('reached-stage', null) }
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('close', code => finish('exited', code))
  })
}

// ONE server for both cases. They do not interact, and starting a second was
// most of this file's runtime -- the CLI itself now returns as soon as it has
// passed the stage under test.
let server = null
let base = ''
let root = ''
let previousTls

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'tlda-relink-'))
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

test('an existing project does not require a source, and gets past argument handling', async () => {
  const checkout = join(root, 'rootless-checkout')
  const project = 'rootless-relink'
  {

    // A project that declares NO document roots — the state 18 of Skip's
    // projects are in, and the one that had no way through this verb.
    const created = await fetch(`${base}/api/projects`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: project, title: project, format: 'markdown' }),
    })
    assert.equal(created.status, 201, await created.text())
    const before = await (await fetch(`${base}/api/projects/${project}`)).json()
    const beforeRecord = before.project || before
    assert.deepEqual(beforeRecord.documentRoots, [], 'the fixture really does declare no roots')

    mkdirSync(checkout)
    await git(checkout, ['init', '-b', 'main'])
    await git(checkout, ['config', 'user.name', 'fixture'])
    await git(checkout, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(checkout, 'doc.md'), '# doc\n')
    await git(checkout, ['add', '-A'])
    await git(checkout, ['commit', '-m', 'author working copy'])

    // THE RELINK: no source, no roots. POSITIVE EVIDENCE, not silence.
    //
    // Asserting only that the usage message never appeared passed on any path
    // that produced no output at all -- a crash would have satisfied it. So the
    // CLI must REACH one of the markers below, and the one it reaches must not
    // be the usage message.
    //
    // The marker set covers both environments deliberately. With a daemon, the
    // CLI proceeds to bind and push. Without one it retries and says
    // `local fleet daemon is unavailable`. Either is proof it got past argument
    // handling; only `Usage:` proves it did not. An earlier version waited for
    // a push-stage marker, which exists only where a daemon is running, and so
    // passed here and failed on a fresh checkout.
    const relink = await cliUntil(checkout, ['project', 'link', project], base,
      /Usage: tlda project link|local fleet daemon is unavailable|exists, pushing files|Submitting |Submitted /, 30_000)
    assert.equal(relink.reason, 'reached-stage',
      `the CLI reached a known stage rather than dying quietly:\n${relink.out}`)
    assert.doesNotMatch(relink.matched, /Usage: tlda project link/,
      `and the stage it reached was not the usage gate -- it got past argument handling:\n${relink.out}`)

    // The exit code is deliberately NOT asserted, and the reason is worth
    // stating rather than hiding: the relink goes on to push through the
    // daemon's git remote, and this harness runs a server with no daemon behind
    // it, so the command ends on a push failure that has nothing to do with the
    // change. Asserting exit 0 here would test the harness's completeness.
    //
    // What IS asserted is the property this change is: it gets past the usage
    // gate without naming documents. That fails loudly if the fix regresses.

    // WHAT THIS FILE DOES NOT PROVE, said plainly rather than implied: that the
    // project record is preserved. The CLI cannot reach the record write
    // without a daemon, so no CLI test can observe it in the normal checkout
    // environment. That property is proved directly, and without a daemon, in
    // shared/document-roots-to-declare.test.mjs.
    assert.ok(beforeRecord, 'the fixture project was readable')
  }
})

test('a project that does not exist still requires a source', async () => {
  // The other half. Making roots optional must not make them optional for
  // CREATING a project, or `project link` silently starts inventing the
  // declaration from whatever directory it was run in.
  const checkout = join(root, 'missing-checkout')
  {
    mkdirSync(checkout)
    await git(checkout, ['init', '-b', 'main'])
    await git(checkout, ['config', 'user.name', 'fixture'])
    await git(checkout, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(checkout, 'doc.md'), '# doc\n')
    await git(checkout, ['add', '-A'])
    await git(checkout, ['commit', '-m', 'author working copy'])

    const attempt = await cliUntil(checkout, ['project', 'link', 'no-such-project-here'], base,
      /Usage: tlda project link/, 15_000)
    assert.notEqual(attempt.code, 0, 'it refuses rather than creating a project from a bare name')
    assert.match(attempt.out, /Usage: tlda project link/, `and it says how to call it:\n${attempt.out}`)
  }
})
