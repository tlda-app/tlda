// A read-only viewer must not POST a signal nobody reads.
//
// Opening a multipage document read-only put a 403 in the console. `SvgDocument`
// reacted to the camera by computing the visible page range and calling
// `writeSignal('signal:viewport', { pages })` from a 500ms debounce; that POSTs
// to `/api/projects/:name/signal`, which is `requireRw`, so a read token was
// refused. Nobody asked for the request: it followed the camera settling, so
// reading the document was enough to produce it.
//
// The refusal was correct. The POST was not: `signal:viewport` existed to give
// the build a page-priority hint, and `b26994172` removed every consumer of it
// — the watcher's SSE handler and cached-signal seed, both server-side
// `priorityPages` resolutions, and the per-page SVG conversion they fed. What
// was left was a writer with no reader, and the repair was to delete it rather
// than to widen read authority so a write to nowhere could succeed.
//
// So this file asserts two different things, and the difference matters:
//
//   1. The route's authority is UNCHANGED. A read token is still refused, for
//      `signal:viewport` and for every other signal. If a later change "fixes" a
//      console 403 by letting read tokens broadcast, these fail. This half
//      passed before the repair and must keep passing.
//   2. Nothing writes `signal:viewport` any more. This half FAILED before the
//      repair and is the control that the deletion actually happened.
//
// The authority half runs over real HTTP against the real `projects` router
// rather than against `requireRw` mounted on a stand-in path. What can be wrong
// here is which middleware that specific route carries, and a hand-mounted
// route would prove the middleware while skipping the thing that can be wrong.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, extname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const READ = 'test-read-token'
const RW = 'test-rw-token'

// ---- child: the real router, behind the real gate ----
if (process.argv[2] === '--serve') {
  const express = (await import('express')).default
  const { initAuth } = await import('../server/lib/auth.mjs')
  const projects = (await import('../server/routes/projects.mjs')).default
  initAuth()
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projects)
  app.listen(Number(process.env.PORT), () => console.log('ready'))
} else {

const PORT = 8700 + (process.pid % 800)
const configDir = mkdtempSync(join(tmpdir(), 'tlda-dead-signal-'))
writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: true\n')

const srv = spawn('node', ['--import', 'tsx', fileURLToPath(import.meta.url), '--serve'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), TLDA_CONFIG_DIR: configDir, TLDA_TOKEN_READ: READ, TLDA_TOKEN_RW: RW },
  stdio: ['ignore', 'pipe', 'pipe'],
})

const stop = () => {
  try { srv.kill('SIGKILL') } catch { /* already gone */ }
  try { rmSync(configDir, { recursive: true, force: true }) } catch { /* temp dir */ }
}
process.on('exit', stop)
// The child's piped stdio would otherwise hold this process open after the last
// assertion, which reads as a hung suite rather than a result.
after(stop)

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not report ready in 30s')), 30000)
  srv.stdout.on('data', d => { if (String(d).includes('ready')) { clearTimeout(timer); resolve() } })
  srv.on('exit', c => { clearTimeout(timer); reject(new Error(`server exited ${c}`)) })
}).catch(e => { stop(); throw e })

/** POST one signal to the real aggregate route. */
const post = (key, token) => fetch(`http://127.0.0.1:${PORT}/api/projects/dead-signal-doc/signal`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ key, pages: [1, 2] }),
}).then(r => r.status)

// The instrument has to be able to answer before an answer means anything. With
// gating off `requireRw` waves everything through, so an all-200 run would look
// exactly like a repair that opened the route to read tokens.
test('the gate is genuinely on', async () => {
  assert.equal(await post('signal:viewport', null), 401, 'no credential must be refused')
  assert.equal(await post('signal:viewport', 'nonsense'), 401, 'a garbage token must be refused')
})

// This is the 403 the read-only viewer's console was showing. It is correct, and
// the repair does not touch it: the fix was to stop asking, not to be allowed.
test('a read token still cannot broadcast a viewport signal', async () => {
  assert.equal(await post('signal:viewport', READ), 403)
})

// The guard against "fixing" the console by widening read authority. Camera and
// presenter drive what other people see; compare pins a build hash server-side.
test('a read token still cannot broadcast any other signal', async () => {
  for (const key of ['signal:presenter', 'signal:camera-link', 'signal:slide-index', 'signal:compare']) {
    assert.equal(await post(key, READ), 403, `${key} must stay read-write only`)
  }
})

// Both directions, or a repair that quietly broke broadcasting would pass.
test('a read-write token still broadcasts', async () => {
  for (const key of ['signal:viewport', 'signal:presenter', 'signal:camera-link', 'signal:slide-index']) {
    assert.equal(await post(key, RW), 200, `${key} must still broadcast for read-write`)
  }
})

// ---- the half that fails before the repair ----

/** Every source file that could reference a signal key. */
function sourceFiles() {
  const out = []
  const skip = new Set(['node_modules', 'dist', '.git', 'scratch', 'public', 'fleet-data'])
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith('public.bak')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (['.ts', '.tsx', '.mjs', '.js'].includes(extname(entry.name))) out.push(full)
    }
  }
  for (const dir of ['src', 'server', 'shared', 'cli', 'bin', 'daemon', 'packages']) {
    const full = join(ROOT, dir)
    try { if (statSync(full).isDirectory()) visit(full) } catch { /* absent */ }
  }
  return out
}

// The rule, not the line number: `signal:viewport` has no reader, so it must
// have no writer and no replay entry either. A replay window for a key nobody
// sends is the same dead weight one indirection further back.
test('nothing references the dead viewport signal', () => {
  const self = join(ROOT, relative(ROOT, fileURLToPath(import.meta.url)))
  const offenders = []
  for (const file of sourceFiles()) {
    if (file === self) continue
    const text = readFileSync(file, 'utf8')
    text.split('\n').forEach((line, i) => {
      if (line.includes('signal:viewport')) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`)
    })
  }
  assert.deepEqual(offenders, [], `signal:viewport has no consumer; these references are dead:\n${offenders.join('\n')}`)
})

}
