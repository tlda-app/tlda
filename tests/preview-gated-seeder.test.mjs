import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import { seedScratchProject } from '../cli/lib/dev-worktree.mjs'

// Does a GATED preview come up with a document, or an empty canvas?
//
// `preview-gated-config.test.mjs` reads the source and can only show what the
// code intends. It passed while the seeder posted unauthenticated and every
// gated preview opened empty — which is exactly what source-reading cannot see.
// This boots a real gated server and asks the seeder to actually seed one.
//
// The control is the pair, not the success: seeding WITHOUT the token must fail
// on the same server, or a green result here would prove only that the server
// was ungated. That is the shape that already fooled us twice tonight.

// mkcert's root is not in Node's trust store, and the preview serves HTTPS.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const READ_TOKEN = 'read-token-for-the-seeder-test'
const RW_TOKEN = 'rw-token-for-the-seeder-test'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(r => setTimeout(r, 25))
  }
  return output
}

test('a gated preview seeds its scratch project, and cannot without the token', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-gated-seed-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // The same config a `--gated` preview writes. Gating is a server.yaml
  // decision: without these two lines the server comes up open, the seeder
  // succeeds for the wrong reason, and this whole file proves nothing.
  const configDir = join(dir, 'config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: true\ntokensFromEnvironmentOnly: true\n')
  for (const f of ['daemon.yaml', 'localhost+2.pem', 'localhost+2-key.pem']) {
    copyFileSync(join(homedir(), '.config', 'tlda', f), join(configDir, f))
  }

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: join(dir, 'fleet.db'),
      TLDA_CONFIG_DIR: configDir,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
      TLDA_TOKEN_READ: READ_TOKEN,
      TLDA_TOKEN_RW: RW_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)) })
  const log = await waitForServer(child)
  assert.match(log, /Token gating enabled/, 'the server came up ungated; nothing below would mean anything')

  const base = `https://127.0.0.1:${port}`

  // The control, first: unauthenticated seeding must be refused on this server.
  const refused = await seedScratchProject(base, 'gated-control', null)
  assert.equal(refused, null, 'the seeder created a project with no credential — the server is not actually gating')

  // And the fix: the same seeder, given the RW token a --gated preview generates.
  const seeded = await seedScratchProject(base, 'gated-seeded', RW_TOKEN)
  assert.ok(seeded, 'a gated preview still opens on an empty canvas — the seeder was refused')

  // Not just a name back: the project has to be there afterwards.
  const listed = await fetch(`${base}/api/projects/${seeded}`, {
    headers: { authorization: `Bearer ${RW_TOKEN}` },
  })
  assert.equal(listed.status, 200, `the seeder reported success but ${seeded} is not on the server`)
})
