/**
 * **Relinking an existing project must not declare anything on its behalf.**
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
import { execFile as execFileCb } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { startServer, stopServer, unusedPort } from '../server/lib/unified-server-test-harness.mjs'

const execFile = promisify(execFileCb)
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'tlda.mjs')

const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8' })

/** Run the CLI exactly as a person would, against the test server. */
async function cli(cwd, args, base) {
  try {
    const { stdout, stderr } = await execFile(process.execPath, [CLI, ...args, '--server', base], {
      cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', GIT_SSL_NO_VERIFY: '1' },
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` }
  }
}

test('an existing rootless project relinks, and its record is untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-relink-rootless-'))
  const projectsDir = join(root, 'projects')
  const checkout = join(root, 'checkout')
  const project = 'rootless-relink'
  const port = await unusedPort()
  const base = `https://127.0.0.1:${port}`
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  let server
  try {
    server = await startServer({ port, projectsDir, fleetDb: join(root, 'fleet.db') })

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

    // THE RELINK: no source, no roots.
    const relink = await cli(checkout, ['project', 'link', project], base)

    // The exit code is deliberately NOT asserted, and the reason is worth
    // stating rather than hiding: the relink goes on to push through the
    // daemon's git remote, and this harness runs a server with no daemon behind
    // it, so the command ends on a push failure that has nothing to do with the
    // change. Asserting exit 0 here would test the harness's completeness.
    //
    // What IS asserted are the two properties this change is: it gets past the
    // usage gate without naming documents, and it declares nothing on the
    // project's behalf. Both still fail loudly if the fix regresses.
    assert.doesNotMatch(relink.out, /Usage: tlda project link/,
      `it does not demand a source for a project that already exists:\n${relink.out}`)

    // THE ASSERTION THAT MATTERS: the record, not the exit code.
    const after = await (await fetch(`${base}/api/projects/${project}`)).json()
    const afterRecord = after.project || after
    assert.deepEqual(afterRecord.documentRoots, [], 'documentRoots is still empty — nothing was declared for it')
    assert.equal(afterRecord.mainFile, beforeRecord.mainFile, 'mainFile unchanged')
    assert.equal(afterRecord.format, beforeRecord.format, 'format unchanged')
  } finally {
    if (server) await stopServer(server)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    rmSync(root, { recursive: true, force: true })
  }
})

test('a project that does not exist still requires a source', async () => {
  // The other half. Making roots optional must not make them optional for
  // CREATING a project, or `project link` silently starts inventing the
  // declaration from whatever directory it was run in.
  const root = mkdtempSync(join(tmpdir(), 'tlda-relink-missing-'))
  const checkout = join(root, 'checkout')
  const port = await unusedPort()
  const base = `https://127.0.0.1:${port}`
  const previousTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  let server
  try {
    server = await startServer({ port, projectsDir: join(root, 'projects'), fleetDb: join(root, 'fleet.db') })
    mkdirSync(checkout)
    await git(checkout, ['init', '-b', 'main'])
    await git(checkout, ['config', 'user.name', 'fixture'])
    await git(checkout, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(checkout, 'doc.md'), '# doc\n')
    await git(checkout, ['add', '-A'])
    await git(checkout, ['commit', '-m', 'author working copy'])

    const attempt = await cli(checkout, ['project', 'link', 'no-such-project-here'], base)
    assert.notEqual(attempt.code, 0, 'it refuses rather than creating a project from a bare name')
    assert.match(attempt.out, /Usage: tlda project link/, `and it says how to call it:\n${attempt.out}`)
  } finally {
    if (server) await stopServer(server)
    if (previousTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTls
    rmSync(root, { recursive: true, force: true })
  }
})
