#!/usr/bin/env node
//
// **Does a browser-shaped write actually CROSS the mounted router?**
//
// Every other proof of this path calls the lifecycle from one process — both
// ends, no wire. `bin/a-second-carrier-onto-one-accept-test.mjs` drives
// `bootstrap`/`submit` directly and proves the accept; it cannot tell you that
// a request reaches it. This one goes over HTTPS, through
// `app.use('/api/projects', projectRoutes)`, through `requireRw` with a real
// bearer token, against a real project store.
//
// It exists because this repository has shipped the sender-and-receiver-but-no-
// wire gap three times: `agent-route` announced into a server that had dropped
// its handler, `adopt-shadow-history` written on both ends with no server case.
// Registration and auth are settled by READING, and reading is not crossing.
//
// ---------------------------------------------------------------------------
// **THE TRAP. Read this before you trust a green.**
//
// `requireRw` opens with `if (!gatingEnabled) return next()`. Token gating is
// OFF unless `server.yaml` sets `tokenGating`, so **a default local boot passes
// every auth assertion in here while testing nothing at all** — the most
// convincing wrong result available on this path.
//
// That is why the first two assertions are controls: an anonymous request must
// come back 401, and a read token must come back 403 on a write. If either one
// returns 200, the auth results below are vacuous and the run is meaningless.
// Do not remove them, and do not "fix" a boot by turning gating off.
// ---------------------------------------------------------------------------
//
// **How to run it.** Boot the server yourself, isolated from this machine's own
// config, projects and fleet db — nothing here should touch a live environment:
//
//   SP=$(mktemp -d)
//   mkdir -p $SP/config $SP/projects $SP/data
//   printf 'tokenGating: true\ntokensFromEnvironmentOnly: true\n' > $SP/config/server.yaml
//   cp ~/.config/tlda/daemon.yaml $SP/config/daemon.yaml     # startup reads it
//   TLDA_CONFIG_DIR=$SP/config TLDA_TOKEN_RW=rw-test TLDA_TOKEN_READ=read-test \
//   PORT=8791 PROJECTS_DIR=$SP/projects TLDA_FLEET_DB=$SP/data/fleet.db \
//     node server/unified-server.mjs --i-am-tlda-cli &
//   TLDA_TOKEN_RW=rw-test TLDA_TOKEN_READ=read-test node bin/a-browser-write-that-crosses-the-router-test.mjs
//
// **Timing.** An accept costs 3–4.5s idle and ~9s under contention, and this box
// runs at load 20+. Measured 2026-08-18: 5.9s, 7.6s, 4.3s at load ~21. **A ten
// second response is the accept being slow, not a hang** — an hour was lost to
// that reading once. Elapsed ms is printed per call so the next person can tell
// the difference.
import assert from 'node:assert/strict'

const BASE = process.env.TLDA_TEST_BASE || 'https://localhost:8791'
const RW = process.env.TLDA_TOKEN_RW || 'rw-test'
const READ = process.env.TLDA_TOKEN_READ || 'read-test'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'   // local mkcert

const PROJECT = `router-crossing-${Date.now()}`
const results = []
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}\n    ${detail}`)
}

async function call(path, { method = 'GET', token = RW, body = null } = {}) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON bodies are reported as text */ }
  return { status: res.status, json, text, ms: Date.now() - t0 }
}

// ---- Controls. Nothing below means anything unless these two hold. ----
const anon = await call('/api/projects', { token: null })
rec('CONTROL anonymous request is rejected', anon.status === 401,
  `GET /api/projects with no token -> ${anon.status} (expect 401; a 200 means gating is off and every auth result here is vacuous)`)

const ro = await call(`/api/projects/${PROJECT}/source-snapshot`, {
  method: 'POST', token: READ, body: { files: [], sourceManifest: [] },
})
rec('CONTROL read token is refused on a write', ro.status === 403,
  `POST .../source-snapshot with the READ token -> ${ro.status} (expect 403; proves requireRw discriminates level rather than merely existing)`)

// ---- A write reaches the route through the mounted router ----
const created = await call('/api/projects', {
  method: 'POST', body: { name: PROJECT, title: 'router crossing', format: 'markdown', mainFile: 'main.md' },
})
rec('project created over the wire', created.status < 400, `POST /api/projects -> ${created.status} in ${created.ms}ms`)

const auth0 = await call(`/api/projects/${PROJECT}/source-authority`)
const base0 = auth0.json?.currentRevision ?? null
rec('fresh project authority reads null', auth0.status === 200 && base0 === null,
  `GET /source-authority -> ${auth0.status}, currentRevision=${JSON.stringify(base0)} (null is the uninitialized case the first write of every new project hits)`)

const first = await call(`/api/projects/${PROJECT}/source-snapshot`, {
  method: 'POST',
  body: {
    files: [{ path: 'main.md', content: 'line one\nline two\nline three\n' }],
    sourceManifest: ['main.md'],
    expectedRevision: base0,
    editedBy: 'router-crossing-test',
  },
})
rec('ACCEPT: a browser-shaped write crosses the router', first.status === 200 && first.json?.ok === true,
  `POST /source-snapshot with RW bearer -> ${first.status} in ${first.ms}ms, sourceRevision=${String(first.json?.sourceRevision).slice(0, 12)}, effects=${JSON.stringify(first.json?.postAcceptEffects)}`)

// The response fields the callers actually read. `building` is gone: the accept
// reports what it RAN, so a caller reading `building` silently stops saying
// "build queued" and says the less informative of two true strings forever.
rec('response carries the fields callers read', typeof first.json?.sourceRevision === 'string' && Array.isArray(first.json?.postAcceptEffects),
  `sourceRevision:${typeof first.json?.sourceRevision} postAcceptEffects:${Array.isArray(first.json?.postAcceptEffects)} unchanged:${JSON.stringify(first.json?.unchanged)} building:${JSON.stringify(first.json?.building)}`)

// ---- Somebody else lands, so our next write is stale ----
const second = await call(`/api/projects/${PROJECT}/source-snapshot`, {
  method: 'POST',
  body: {
    files: [{ path: 'main.md', content: 'line one\nSOMEBODY ELSE\nline three\n' }],
    sourceManifest: ['main.md'],
    expectedRevision: first.json?.sourceRevision ?? null,
    editedBy: 'other-participant',
  },
})
rec('a second participant lands on top', second.status === 200 && second.json?.ok === true,
  `POST -> ${second.status} in ${second.ms}ms, sourceRevision=${String(second.json?.sourceRevision).slice(0, 12)}`)

// ---- The refusal, which is the half that carries the resolution path ----
const stale = await call(`/api/projects/${PROJECT}/source-snapshot`, {
  method: 'POST',
  body: {
    files: [{ path: 'main.md', content: 'line one\nMY OWN EDIT\nline three\n' }],
    sourceManifest: ['main.md'],
    expectedRevision: first.json?.sourceRevision ?? null,   // deliberately the superseded head
    editedBy: 'fleet-source-editor',
  },
})
rec('REFUSAL: a stale-base write is refused', stale.status === 409,
  `POST with a superseded expectedRevision -> ${stale.status} in ${stale.ms}ms, status=${JSON.stringify(stale.json?.status)}`)

// `conflictedTextFor` in src/shapes/FleetSourceEditorShape.tsx is .tsx and is
// NOT executed here. Its four preconditions are asserted one at a time against
// the real payload, and the base64 decode below is the same decode it performs.
// A refusal that returns only a status turns "resolve the markers and it syncs"
// into "sync 409" on the surface Skip edits his paper on.
const p = stale.json || {}
const cls = p.evidence?.classifications
const match = Array.isArray(cls) ? cls.find(c => c?.path === 'main.md' && c?.status === 'conflict' && c?.merged) : null
let mergedText = null
try { mergedText = match ? Buffer.from(match.merged, 'base64').toString('utf8') : null } catch { /* reported as a failure below */ }

rec('  precondition 1: status is stale-base', (p.status ?? p.lifecycleStatus) === 'stale-base', `status=${JSON.stringify(p.status ?? p.lifecycleStatus)}`)
rec('  precondition 2: evidence.classifications[] present', Array.isArray(cls), `classifications=${Array.isArray(cls) ? `${cls.length} entry(s)` : JSON.stringify(cls)}`)
rec('  precondition 3: this path is classified conflict WITH merged', !!match, `entry=${JSON.stringify(match && { path: match.path, status: match.status, hasMerged: !!match.merged })}`)
rec('  precondition 4: merged decodes to real conflict markers',
  !!mergedText && mergedText.includes('<<<<<<<') && mergedText.includes('=======') && mergedText.includes('>>>>>>>'),
  mergedText ? JSON.stringify(mergedText) : 'no merged text')

// The read that decides whether a conflict can ever be resolved. The refused
// head is TOP-LEVEL `currentRevision`; the old route nested it under
// `authority`. That value becomes the next write's `expectedRevision`, so
// reading the nested path yields undefined, the editor keeps the stale revision
// it already had, and the resolved write is refused for the reason the first one
// was — a conflict a person cannot get out of by resolving it.
rec('refused head is top-level currentRevision, not nested under authority',
  typeof p.currentRevision === 'string' && p.authority?.currentRevision === undefined,
  `currentRevision=${String(p.currentRevision).slice(0, 12)} authority.currentRevision=${JSON.stringify(p.authority?.currentRevision)}`)

console.log(`\n${results.filter(r => r.ok).length}/${results.length} pass`)
const failed = results.filter(r => !r.ok)
for (const f of failed) console.log(`FAILED: ${f.name} — ${f.detail}`)
assert.equal(failed.length, 0, `${failed.length} assertion(s) failed`)
