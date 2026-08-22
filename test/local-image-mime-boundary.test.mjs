/**
 * `/api/local-image` must serve images and nothing else.
 *
 * This crosses real HTTP against a real `unified-server.mjs` process with token
 * gating on, because the thing under test is a route plus its middleware plus
 * the wire — calling `resolveLocalImage()` in-process would prove the function
 * and nothing about what the server answers. See AGENTS.md §"Prove the wire, not
 * the two ends".
 *
 * The canary file is written by this test, outside the server's `PROJECTS_DIR`
 * and outside every project. Nothing of anyone's is read.
 *
 * The image case is the control, and it is the reason this test is not just an
 * assertion that something got refused: a fix that broke local images in notes
 * would also make the first assertion pass.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const CANARY = 'CANARY-LOCAL-IMAGE-MIME-BOUNDARY'
const READ_TOKEN = 'probe-read-token'

// A fixed port collides with whatever else this machine is running. Ask the OS
// for a free one: this test's sibling hit EADDRINUSE on its first run doing it
// the other way, and a flake in a boundary test reads as the boundary failing.
function freePort() {
  return new Promise((resolvePromise, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, () => {
      const { port } = probe.address()
      probe.close(() => resolvePromise(port))
    })
  })
}

// A 1x1 transparent PNG. Small enough to inline, real enough that `mime-types`
// and the server both treat it as the image it is.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

function writeFixtureConfig(dir, PORT) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server.yaml'), 'tokenGating: true\ntokensFromEnvironmentOnly: true\n')
  writeFileSync(join(dir, 'daemon.yaml'), [
    'environments:',
    '  default: "local-image-test"',
    '  values:',
    '    "local-image-test":',
    `      database: "http://localhost:${PORT}"`,
    `      store: "http://localhost:${PORT}"`,
    '      licenseKey: ""',
    '',
  ].join('\n'))
}

/** Resolves to the origin the server printed, so the test follows its TLS decision. */
function startServer(root, env) {
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within 90s:\n${log}`)), 90_000)
    const onData = (chunk) => {
      log += chunk
      const m = log.match(/Unified server running on (https?):\/\/[^:\s]+:(\d+)/)
      if (m) {
        clearTimeout(timer)
        resolvePromise({ child, origin: `${m[1]}://localhost:${m[2]}`, log: () => log })
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`server exited with ${code} before listening:\n${log}`))
    })
  })
}

test('/api/local-image serves images and refuses everything else', { timeout: 180_000 }, async (t) => {
  // The fixture server uses its own self-signed cert; this process talks only to it.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

  const root = new URL('..', import.meta.url).pathname
  const scratch = mkdtempSync(join(tmpdir(), 'local-image-boundary-'))
  const canaryPath = join(scratch, 'not-an-image.md')
  const imagePath = join(scratch, 'figure.png')
  writeFileSync(canaryPath, `# Not an image\n\n${CANARY}\n`)
  writeFileSync(imagePath, PNG_1X1)

  const PORT = await freePort()
  writeFixtureConfig(join(scratch, 'config'), PORT)
  mkdirSync(join(scratch, 'projects'), { recursive: true })

  const started = await startServer(root, {
    TLDA_ENV: 'local-image-test',
    TLDA_CONFIG_DIR: join(scratch, 'config'),
    TLDA_FLEET_DB: join(scratch, 'fleet.db'),
    PROJECTS_DIR: join(scratch, 'projects'),
    PORT: String(PORT),
    TLDA_TOKEN_READ: READ_TOKEN,
    TLDA_TOKEN_RW: 'probe-rw-token',
  })

  t.after(() => {
    started.child.kill('SIGTERM')
    rmSync(scratch, { recursive: true, force: true })
  })

  const get = (path, headers = {}) =>
    fetch(`${started.origin}/api/local-image?path=${encodeURIComponent(path)}`, { headers })
  const readHeaders = { Authorization: `Bearer ${READ_TOKEN}` }

  // The read gate itself still works. If this ever passes without a token the
  // rest of the test is measuring nothing.
  const unauthed = await get(canaryPath)
  assert.equal(unauthed.status, 401, 'no token must not reach the route at all')

  // The finding: a bare read token reading a non-image file outside any project.
  const nonImage = await get(canaryPath, readHeaders)
  const nonImageBody = await nonImage.text()
  assert.equal(nonImage.status, 415, `a read token must not read a non-image; got ${nonImage.status}`)
  assert.ok(!nonImageBody.includes(CANARY), 'the file\'s bytes must not appear in the response')

  // The control: the feature this route exists for still works. Without this,
  // deleting the route would pass the assertion above.
  const image = await get(imagePath, readHeaders)
  const imageBody = Buffer.from(await image.arrayBuffer())
  assert.equal(image.status, 200, 'a real image must still be served')
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual(imageBody, PNG_1X1, 'the image bytes must arrive intact')
})
