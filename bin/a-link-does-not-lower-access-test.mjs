// A `?token=` link must never take access away from a browser that already has
// access, and no token admits more than any other.
//
// Tokens carry identity and nothing else — there is no read token and no RW
// token, only the token(s) in the environment. A caller holding any valid
// token is admitted; a caller holding none is not. This test is the no-demotion
// invariant: following a link, presenting a second token, or logging in with
// one token while holding another can neither reduce nor widen what the browser
// may do. Admission is one bit.
//
// History, kept because the shape of the test is the shape of the old defect:
// Skip's course syllabus links to `/app`, which resolves to a URL carrying the
// class's token. The defect was what happened when HE followed his own
// syllabus: the token in the URL outranked his cookie by being written down in
// a more preferred place, so `extractToken` handed the weaker one to every
// gate — and `/auth/login` overwrote the cookie outright, a 30-day demotion
// with no logout to undo it. The ranking is gone; what remains is that
// following a link must not cost the browser anything, in either direction.
//
// This has to run over real HTTP: the defect lives in how three credential
// sources on one request combine, and cookie and query parsing are part of the
// mechanism. Calling `extractToken` with a hand-built object would prove a
// function and skip the thing that can be wrong.
//
// Both tokens are asserted in both positions, because a fix that quietly broke
// enrollment would be far worse than the defect — that link is how the class
// gets in.
//
// The WebSocket half is not a bonus. `/sync/` feeds admission straight into
// the room, so a refusal there does not merely 403 an API call — it keeps the
// canvas from mounting at all. And an upgrade is where admission is least
// obviously safe: a browser WebSocket cannot set an Authorization header, so
// the cookie is the only place a second credential can be, and whether it
// rides an upgrade request at all is a fact about the transport rather than
// about this code.
import WebSocket, { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TOKEN_A = 'test-token-a'
const TOKEN_B = 'test-token-b'

// ---- child: the server under test, running the real middleware ----
if (process.argv[2] === '--serve') {
  const express = (await import('express')).default
  const { initAuth, loginRoute, requireRead, requireOperatorWrite, resolveIdentity, extractToken } = await import('../server/lib/auth.mjs')
  initAuth()
  const app = express()
  app.get('/auth/login', loginRoute)
  app.get('/read', requireRead, (req, res) => res.json({ admitted: true }))
  app.get('/write', requireOperatorWrite, (req, res) => res.json({ admitted: true }))
  const server = app.listen(Number(process.env.PORT), () => console.log('ready'))

  // The same expression the real `/sync/` upgrade uses to decide admission,
  // reached the same way: off the raw upgrade request, before any handshake.
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    if (!resolveIdentity(extractToken(req))) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return }
    wss.handleUpgrade(req, socket, head, ws => ws.send(JSON.stringify({ admitted: true })))
  })
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
    env: { ...process.env, PORT: String(PORT), TLDA_CONFIG_DIR: configDir, TLDA_TOKEN_READ: TOKEN_A, TLDA_TOKEN_RW: TOKEN_B },
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
  const admitted = async (res) => res.ok && (await res.json()).admitted === true

  // The instrument has to be able to answer before an answer means anything:
  // gating is genuinely on, so an unauthorized request is refused.
  check('gating is on — no credential is refused', (await get('/read')).status === 401)
  check('gating is on — a garbage token alone is refused', (await get('/read?token=nonsense')).status === 401)

  // --- either token admits, everywhere, by itself ---
  check('token A link admits read', await admitted(await get(`/read?token=${TOKEN_A}`)))
  check('token B link admits read', await admitted(await get(`/read?token=${TOKEN_B}`)))
  check('token A cookie admits write', await admitted(await get('/write', { cookie: TOKEN_A })))
  check('token B cookie admits write', await admitted(await get('/write', { cookie: TOKEN_B })))
  check('token A link admits write', await admitted(await get(`/write?token=${TOKEN_A}`)))
  check('token B link admits write', await admitted(await get(`/write?token=${TOKEN_B}`)))

  // --- a link never costs the browser anything, in either direction ---
  check('B cookie + A link still admits', await admitted(await get(`/read?token=${TOKEN_A}`, { cookie: TOKEN_B })))
  check('A cookie + B link still admits', await admitted(await get(`/read?token=${TOKEN_B}`, { cookie: TOKEN_A })))
  check('B cookie + A bearer still admits', await admitted(await get('/write', { cookie: TOKEN_B, bearer: TOKEN_A })))
  check('an invalid token in a link does not lock out a valid cookie',
    await admitted(await get('/read?token=nonsense', { cookie: TOKEN_B })))

  // --- enrollment still works: a link is remembered, login redirects ---
  check('a link is remembered as a cookie',
    (await get(`/read?token=${TOKEN_A}`)).headers.get('set-cookie')?.includes(TOKEN_A) === true)
  const login = await get(`/auth/login?token=${TOKEN_A}`)
  check('/auth/login accepts a valid token', login.status === 302)
  check('/auth/login sets the cookie',
    login.headers.get('set-cookie')?.includes(TOKEN_A) === true)
  // Following a link writes the presented token into the cookie outright.
  // Tokens carry no level, so no token can demote the browser: any valid token
  // admits the same, and the writeback is a no-op in authority.
  const crossLogin = await get(`/auth/login?token=${TOKEN_A}`, { cookie: TOKEN_B })
  check('/auth/login still redirects rather than erroring', crossLogin.status === 302)
  check('no token demotes another through login',
    await admitted(await get('/write', { cookie: TOKEN_A })))

  // --- the sync socket: admission, not levels ---
  const upgrade = (query, cookie) => new Promise(resolve => {
    const ws = new WebSocket(`ws://localhost:${PORT}/sync/doc-any${query}`,
      cookie ? { headers: { cookie: `tlda_token=${cookie}` } } : {})
    const done = v => { try { ws.close() } catch { /* already closing */ } resolve(v) }
    ws.on('message', d => done(JSON.parse(String(d))))
    ws.on('error', e => done({ admitted: `error ${e.message}` }))
    setTimeout(() => done({ admitted: 'timeout' }), 8000)
  })

  const tokenSocket = await upgrade(`?token=${TOKEN_A}`)
  check('sync socket: token link connects', tokenSocket.admitted === true)
  const cookieSocket = await upgrade(`?token=${TOKEN_A}`, TOKEN_B)
  check('sync socket: cookie + link connects', cookieSocket.admitted === true)
  check('sync socket: no credential is refused', (await upgrade('')).admitted !== true)

  console.log(failures === 0 ? 'PASS' : `FAIL: ${failures} check(s)`)
  cleanup(failures === 0 ? 0 : 1)
}
