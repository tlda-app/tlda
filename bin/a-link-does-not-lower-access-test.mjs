// A `?token=` link must never take access away from a browser that already has
// more.
//
// Skip's course syllabus links to `/app`, which resolves to a URL carrying the
// class's read token. Students are meant to have that. The defect was what
// happened when HE followed his own syllabus: the read token in the URL
// outranked his read-write cookie by being written down in a more preferred
// place, so `extractToken` handed the read one to every gate. And there is no
// logout — `/auth/login` overwrote the cookie outright, which made it a 30-day
// demotion with nothing to undo it.
//
// This is the class of failure that is both silent and close to irreversible,
// which is what earns a test rather than a note. It also has to run over real
// HTTP: the whole defect lives in how three credential sources on one request
// are ranked, and cookie and query parsing are part of the mechanism. Calling
// `extractToken` with a hand-built object would prove a function and skip the
// thing that can be wrong.
//
// Both directions are asserted, because a fix that quietly broke enrollment
// would be far worse than the defect — that link is how the class gets in.
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const READ = 'test-read-token'
const RW = 'test-rw-token'

// ---- child: the server under test, running the real middleware ----
if (process.argv[2] === '--serve') {
  const express = (await import('express')).default
  const { initAuth, loginRoute, requireRead, requireRw } = await import('../server/lib/auth.mjs')
  initAuth()
  const app = express()
  app.get('/auth/login', loginRoute)
  app.get('/read', requireRead, (req, res) => res.json({ level: req.authLevel }))
  app.get('/rw', requireRw, (req, res) => res.json({ level: req.authLevel }))
  app.listen(Number(process.env.PORT), () => console.log('ready'))
} else {
  const PORT = 8700 + (process.pid % 800)
  const configDir = mkdtempSync(join(tmpdir(), 'tlda-link-access-'))
  writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: true\n')

  let failures = 0
  const check = (label, ok, detail = '') => {
    if (ok) console.log(`  ok   ${label}`)
    else { failures++; console.error(`  FAIL ${label}${detail ? `: ${detail}` : ''}`) }
  }

  const srv = spawn('node', [fileURLToPath(import.meta.url), '--serve'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), TLDA_CONFIG_DIR: configDir, TLDA_TOKEN_READ: READ, TLDA_TOKEN_RW: RW },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const cleanup = (code) => {
    try { srv.kill('SIGKILL') } catch { /* already gone */ }
    try { rmSync(configDir, { recursive: true, force: true }) } catch { /* temp dir */ }
    process.exit(code)
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not report ready in 20s')), 20000)
    srv.stdout.on('data', d => { if (String(d).includes('ready')) { clearTimeout(timer); resolve() } })
    srv.stderr.on('data', d => process.stderr.write(d))
    srv.on('exit', c => { clearTimeout(timer); reject(new Error(`server exited ${c}`)) })
  }).catch(e => { console.error('FAIL:', e.message); cleanup(1) })

  const get = (path, { cookie, bearer } = {}) => {
    const headers = {}
    if (cookie) headers.cookie = `tlda_token=${cookie}`
    if (bearer) headers.authorization = `Bearer ${bearer}`
    return fetch(`http://localhost:${PORT}${path}`, { headers, redirect: 'manual' })
  }
  const level = async (res) => (res.ok ? (await res.json()).level : `HTTP ${res.status}`)

  // The instrument has to be able to answer before an answer means anything:
  // gating is genuinely on, so an unauthorized request is refused.
  check('gating is on — no credential is refused', (await get('/read')).status === 401)
  check('gating is on — a garbage token alone is refused', (await get('/read?token=nonsense')).status === 401)

  // --- a student, who has no session: nothing about enrollment may change ---
  check('student: read link grants read', await level(await get(`/read?token=${READ}`)) === 'read')
  check('student: read link is remembered as a cookie',
    (await get(`/read?token=${READ}`)).headers.get('set-cookie')?.includes(READ) === true)
  const studentLogin = await get(`/auth/login?token=${READ}`)
  check('student: /auth/login accepts the read token', studentLogin.status === 302)
  check('student: /auth/login sets the read cookie',
    studentLogin.headers.get('set-cookie')?.includes(READ) === true)
  check('student: a read cookie alone still cannot write',
    (await get('/rw', { cookie: READ })).status === 403)

  // --- Skip, who already holds read-write: the link must not cost him anything ---
  check('rw cookie + read link stays rw',
    await level(await get(`/read?token=${READ}`, { cookie: RW })) === 'rw')
  check('rw cookie + read link can still write',
    await level(await get(`/rw?token=${READ}`, { cookie: RW })) === 'rw')
  check('rw cookie + read link does not rewrite the cookie',
    (await get(`/read?token=${READ}`, { cookie: RW })).headers.get('set-cookie') === null)
  // The same demotion arriving as a header: the page stores the link's token in
  // localStorage and sends it as a Bearer on every fetch, so it outlived the URL.
  check('rw cookie + read bearer stays rw',
    await level(await get('/rw', { cookie: RW, bearer: READ })) === 'rw')
  // The irreversible one: this route overwrites the cookie outright.
  const downgradeLogin = await get(`/auth/login?token=${READ}`, { cookie: RW })
  check('/auth/login with a read token does not overwrite an rw cookie',
    downgradeLogin.headers.get('set-cookie') === null)
  check('/auth/login still redirects rather than erroring', downgradeLogin.status === 302)
  check('an invalid token in a link does not lock out a valid cookie',
    await level(await get('/read?token=nonsense', { cookie: RW })) === 'rw')

  // --- upward is still allowed, and it persists, or he needs the link forever ---
  check('read cookie + rw link grants rw',
    await level(await get(`/read?token=${RW}`, { cookie: READ })) === 'rw')
  check('read cookie + rw link upgrades the cookie',
    (await get(`/read?token=${RW}`, { cookie: READ })).headers.get('set-cookie')?.includes(RW) === true)

  console.log(failures === 0 ? 'PASS' : `FAIL: ${failures} check(s)`)
  cleanup(failures === 0 ? 0 : 1)
}
