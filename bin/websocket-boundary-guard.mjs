#!/usr/bin/env node
// Every WebSocket in this repository goes through the sealed transport library,
// or it is listed here with a reason.
//
// Skip's decision, 2026-07-21: "one uniformly-used transport library that does
// durability and sockets right... an internal library that no one fucks with."
// He defined done as deletion plus a guard that fails on any `new WebSocket`
// outside the library. The stopgap that night was `11414bc4` (reaper grace);
// the consolidation never started, and by 2026-08-09 nobody could say how big
// the problem was without re-grepping. That is why it stalled.
//
// This guard is the number. It does not consolidate anything and it cannot
// break the app -- it reads files. What it does is turn "we should unify
// transport" into a count that either goes down or does not.
//
// ---------------------------------------------------------------------------
// THE BOUNDARY
//
// Established from the code, not from a description of it. `shared/` holds the
// library: `shared/resilient-ws.mjs` is the only module that constructs a
// client socket (line 129, `new this._WebSocketImpl(...)`), and it is fronted
// by two barrels -- `shared/fleet-transport.mjs` for Node and
// `shared/fleet-browser-transport.mjs` for the browser. Everything under
// `shared/` is inside. Everything else is outside and must be listed.
//
// ---------------------------------------------------------------------------
// WHAT IT COUNTS, AND WHAT IT DELIBERATELY DOES NOT
//
// Counted: `new WebSocket(...)` -- an outbound client connection, which is the
// thing ResilientWS replaces and the thing Skip named.
//
// NOT counted as a failure: `new WebSocketServer(...)`. That is the accept
// side. A listener is not a connection, ResilientWS does not replace one, and
// folding the two into one number would make the number mean nothing. The four
// in `server/unified-server.mjs` and the bridges' own listeners are reported
// under a separate heading, as context, without blocking.
//
// NOT scanned: anything git does not track. Build output is the reason --
// counting a bundled copy of `src/voice.mjs` inflates the count with the same
// socket twice and makes the baseline meaningless. The first run of this guard
// failed on exactly that: `public/assets/index-BETHBNov.js` (our own bundle)
// and a vendored Grafana build under `telemetry/.stack/`, both gitignored.
// `git ls-files` removes the whole class -- bundles, vendored stacks, scratch
// checkouts -- rather than a path list that has to be extended each time a new
// build directory appears.
//
// ---------------------------------------------------------------------------
// WHAT IT CANNOT SEE -- read this before trusting the number
//
// Detection is textual. It resolves the local binding for the `ws` module in
// each file (`import WebSocket from 'ws'`, `{ WebSocket as X }`, `require('ws')`)
// and then follows plain aliasing to a fixpoint, in any binding position -- the
// site in `packages/bot/index.mjs` is reached through a destructured default
// parameter, `WebSocketClass = WebSocket`, not a `const`, and the first version
// of this guard missed it. It always treats the bare global `WebSocket` as a
// construction. Comments and string literals are stripped first -- without
// that, the comment on `src/voice.mjs:2419` reads as a socket.
//
// It therefore cannot see:
//   - a socket built through a computed member expression or a factory it was
//     handed (`new this._WebSocketImpl(...)`, `makeSocket()(...)`). This is not
//     hypothetical: it is exactly how the library itself constructs.
//   - a socket opened by a dependency on our behalf. tldraw sync and the
//     Yjs client connect from inside node_modules; no line of our source
//     shows it, so it is absent from this count rather than compliant.
//   - whether a listed site is a thin wrapper that should be inside the
//     library or a genuinely separate protocol. That judgement is in the
//     `reason` field below, written by a person, and this guard does not
//     verify it.
//   - a socket in a file that is not yet `git add`ed. That is the cost of
//     scanning tracked files, and it is the right trade: CI and the commit are
//     where this must hold, and the alternative is a path list that misses a
//     build directory nobody remembered.
//
// So: the count is a lower bound on sites, and it says nothing about how much
// work each one is.
//
// ---------------------------------------------------------------------------
// THE RATCHET
//
// Each entry pins a file and the number of construction sites in it. A new
// socket in a new file fails. A second socket in an already-listed file also
// fails -- listing a file does not open it up. Removing sites requires editing
// the count down, which is the moment the number moves.
//
// `category` is what the number means:
//   'product'   -- reaching around the library. This is the number that should
//                  go to zero. It is the baseline.
//   'exception' -- a protocol the library does not carry. Named when the
//                  decision was made, not pattern-matched away. Stays.
//   'tooling'   -- tests and scripts that speak the wire on purpose, to test
//                  it. Not product surface; tracked so it cannot grow quietly.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Inside the boundary. Not scanned, not counted.
const LIBRARY = ['shared/']

const SOURCE = /\.(mjs|cjs|js|jsx|ts|tsx)$/
const MINIFIED = /\.min\.js$/

// ---------------------------------------------------------------------------
// The allowlist. One line per file, with the count and the reason it is there.
//
// An exception must say which protocol and why the library cannot carry it. "It
// is different" is not a reason; if you cannot name the protocol, the entry is
// a product site that has not been looked at yet.

const ALLOWED = {
  // --- wire tests: the socket IS the thing under test ----------------------
  //
  // Each of these drives a real endpoint to prove frames cross it. Routing them
  // through the transport library would test the library instead of the wire,
  // which is the one thing these exist to check -- and this repository has
  // shipped both ends of a severed wire more than once while every unit test
  // stayed green.

  'bin/a-message-id-can-be-read-back-test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Reads a message back by the id the server assigned it, over the socket the MCP transport uses. The wire is the whole claim: thread(message_id:) sends the ephemeral verb `event-by-id` and dispatchFleetWsMessage answers it, and calling both functions in one process would prove the two ends and not that they are joined. Endpoint: /ws/fleet.',
  },

  'bin/the-room-and-a-git-remote-test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Source-room client speaking the room\'s JSON frames against a linked git remote. Endpoint: /source-sync/.',
  },
  'bin/typing-when-the-socket-goes-away-test.mjs': {
    count: 2,
    category: 'tooling',
    reason: 'Two source-room clients: the story is a socket dying mid-edit, which needs one connection to lose and one to observe with. Endpoint: /source-sync/.',
  },
  'scripts/backfill-agent-models.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'One-off backfill script. Not a server path and not a product site; it opens /ws/fleet once to write agent models and exits. Endpoint: /ws/fleet.',
  },
  'server/lib/agent-model-backfill-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Wire test for the model backfill: drives /ws/fleet directly to prove the frames, not the function. Endpoint: /ws/fleet.',
  },
  'bin/search-takes-a-message-id-test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Wire test for the `id:` search term: boots a real server and drives /ws/fleet directly so the shared parser is on the path from a typed string, rather than a hand-built filter expression. Same shape and same endpoint as conversation-search-wire.test.mjs. Endpoint: /ws/fleet.',
  },
  'server/lib/conversation-search-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Wire test for conversation search over /ws/fleet. Endpoint: /ws/fleet.',
  },
  'server/lib/lifecycle-reanimate-authority-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Reanimate authority over the daemon socket -- the wire is the thing under test. Endpoint: /ws/fleet-daemon.',
  },
  'server/lib/manual-preamble-edit-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Manual preamble crossing the production daemon activity websocket and a history reconnect. Endpoint: /ws/fleet.',
  },
  'server/lib/operation-coalesce-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Operation coalescing over /ws/fleet: coalescing is a property of the wire, not of a function. Endpoint: /ws/fleet.',
  },
  'server/lib/read-receipt-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Read receipts over /ws/fleet. Endpoint: /ws/fleet.',
  },
  'server/lib/recording-authority.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Recording authority: needs a real fleet socket to exercise the token levels. Endpoint: /ws/fleet.',
  },
  'server/lib/short-image-reference-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Short image references over /ws/fleet. Endpoint: /ws/fleet.',
  },
  'server/lib/subscription-history-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'Subscription history over /ws/fleet. Endpoint: /ws/fleet.',
  },
  'server/lib/unknown-codex-tool-wire.test.mjs': {
    count: 1,
    category: 'tooling',
    reason: 'An unknown Codex tool arriving over /ws/fleet and rendering without a handler for it. Endpoint: /ws/fleet.',
  },
  // --- exceptions: protocols the fleet transport does not carry ------------
  'src/voice.mjs': {
    count: 2,
    category: 'exception',
    reason:
      'Voice has its own path and was named as an exception when the decision was made. ' +
      'Two bridges, each a raw audio wire rather than fleet messages: the Whisper bridge ' +
      'and the Deepgram relay. Neither carries durable operations, so the outbox and ' +
      'request-response machinery in the library have nothing to do here.',
  },
  'src/shapes/FleetSourceEditorShape.tsx': {
    count: 1,
    category: 'exception',
    reason:
      'Source editor Yjs protocol. This socket carries y-codemirror.next Y.Text ' +
      'updates and an initial Yjs state update for one source file; it is not a ' +
      'fleet operation stream and must not replay durable outbox messages through ' +
      'the fleet request-response transport.',
  },

  // --- product: reaching around the library. This is the number. -----------
  'src/fleet/fleet-data.mjs': {
    count: 1,
    category: 'product',
    reason:
      'The browser fleet channel. Hand-rolled reconnect, backoff and connect-timeout ' +
      'that duplicate ResilientWS -- its own comment at line 848 points at ' +
      'shared/resilient-ws.mjs for the heartbeat equivalent. It already imports the ' +
      'browser barrel for request policy and the reconnect buffer, so the socket is ' +
      'the only part still outside.',
  },
  'src/fleet/terminal-transport.ts': {
    count: 1,
    category: 'product',
    reason:
      'Terminal PTY channel. Deliberately ephemeral -- input and resize frames must ' +
      'never replay after reconnect -- so it needs the transient-signal primitive, not ' +
      'durability. The library declares TRANSIENT_SIGNAL and this predates it being ' +
      'usable from the browser.',
  },
  'mcp-server/fleet-tools.mjs': {
    count: 1,
    category: 'product',
    reason:
      'MCP fleet channel. The same file already imports shared/fleet-transport.mjs for ' +
      'the outbox, so this is a partial adoption with the socket left behind.',
  },
  'agent-launch/register.mjs': {
    count: 1,
    category: 'product',
    reason:
      'Agent registration at launch. One-shot connect with no reconnect at all, which ' +
      'is why it looks unlike the others; it still speaks the fleet wire.',
  },

  // --- tooling: test and script clients that speak the wire on purpose -----
  'bin/collaborators-and-an-editor-test.mjs': { count: 2, category: 'tooling', reason: 'Source-room clients: two of them, on /source-sync/<project>/<file>, speaking the room\'s JSON frames — sync, update, flush, status — with base64 Yjs updates inside. Two because the story is two people with one file open at once, which one socket cannot show.' },
  'bin/delegate-spawn-shell-e2e-test.mjs': { count: 2, category: 'tooling', reason: 'E2E client: drives /ws/fleet and /ws/fleet-daemon directly to test the wire.' },
  'bin/server-originated-claude-mint-real-daemon-test.mjs': { count: 1, category: 'tooling', reason: 'Real-daemon mint test: one /ws/fleet client in openFleet(), same shape as the spawn tests beside it.' },
  'bin/source-room-daemon-test.mjs': { count: 3, category: 'tooling', reason: 'Source-room protocol tests: Node participants open /source-sync to send Yjs updates without a browser, including checkpoint-error and duplicate-render cases.' },
  'bin/filter-expr-integration.mjs': { count: 1, category: 'tooling', reason: 'Integration client for filter expressions over the live fleet socket.' },
  'bin/spawn-collision-test.mjs': { count: 2, category: 'tooling', reason: 'Spawn collision test: needs two independent raw connections to race them.' },
  'bin/spawn-mailbox-outcome-test.mjs': { count: 2, category: 'tooling', reason: 'Mailbox outcome test: agent and daemon sockets, asserted against directly.' },
  'bin/suggestions-test.mjs': { count: 1, category: 'tooling', reason: 'Suggestions test client.' },
  'bin/test-refevent-amend.mjs': { count: 1, category: 'tooling', reason: 'Ref-event amend test client.' },
  'bin/test-source-roundtrip.mjs': { count: 1, category: 'tooling', reason: 'Source roundtrip test client.' },
  'scripts/smoke-test.mjs': { count: 1, category: 'tooling', reason: 'Smoke test: constructs the socket inside browser-evaluated source, in the page.' },
  'server/lib/fleet-inbox-delivery.test.mjs': { count: 1, category: 'tooling', reason: 'Delivery test: one openFleetWs() helper, called per client to observe fan-out.' },
  'server/lib/fleet-login-route-gate.test.mjs': { count: 1, category: 'tooling', reason: 'Login route gate test: one /ws/fleet client in openFleetWs(), asserted against directly.' },
  'server/lib/fleet-store-offloop.test.mjs': { count: 1, category: 'tooling', reason: 'Off-loop store test client.' },
}

// ---------------------------------------------------------------------------

function stripCommentsAndStrings(src) {
  // Character-state machine rather than regexes: `src/voice.mjs:2419` is a
  // comment containing "new WebSocket", and matching it would put a phantom
  // site in the baseline. Replaces removed spans with spaces so line numbers
  // survive.
  let out = ''
  let i = 0
  const n = src.length
  let state = 'code'
  let quote = ''
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && next === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === '"' || c === "'" || c === '`') { state = 'string'; quote = c; out += ' '; i++; continue }
      out += c; i++; continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; i++; continue }
      out += ' '; i++; continue
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; out += '  '; i += 2; continue }
      out += c === '\n' ? c : ' '; i++; continue
    }
    // string
    if (c === '\\') { out += '  '; i += 2; continue }
    if (c === quote) { state = 'code'; out += ' '; i++; continue }
    out += c === '\n' ? c : ' '; i++
  }
  return out
}

function addNamed(names, part) {
  const m = part.trim().match(/^(\w+)(?:\s+as\s+(\w+))?$/)
  if (!m) return
  const local = m[2] ?? m[1]
  if (m[1] === 'WebSocket' || m[1] === 'default') names.add(local)
}

function socketBindings(src) {
  // Local names bound to the `ws` module, plus the browser global, plus one
  // level of plain aliasing. Anything deeper is in "what it cannot see" above.
  const names = new Set(['WebSocket'])
  for (const m of src.matchAll(/import\s+(\w+)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]ws['"]/g)) {
    names.add(m[1])
    for (const part of (m[2] ?? '').split(',')) addNamed(names, part)
  }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]ws['"]/g)) {
    for (const part of m[1].split(',')) addNamed(names, part)
  }
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]ws['"]\s*\)/g)) names.add(m[1])
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]ws['"]\s*\)/g)) {
    for (const part of m[1].split(',')) addNamed(names, part)
  }
  // Follow aliasing to a fixpoint, in any binding position: `const X = WebSocket`,
  // `X = Y ?? WebSocket`, and the destructured default parameter
  // `WebSocketClass = WebSocket` that `packages/bot/index.mjs` uses.
  //
  // `=` only, never `==`/`===`/`!=`/`<=`/`>=`, or `readyState === WebSocketClass.OPEN`
  // would bind `readyState`. An RHS containing `new` is a construction being
  // stored, not an alias of the constructor.
  for (let grew = true; grew; ) {
    grew = false
    for (const known of [...names]) {
      const re = new RegExp(String.raw`(?<![=!<>])(\w+)\s*=(?!=)\s*([^\n,;)]*\b${known}\b)`, 'g')
      for (const m of src.matchAll(re)) {
        if (/\bnew\b/.test(m[2])) continue
        if (names.has(m[1])) continue
        names.add(m[1])
        grew = true
      }
    }
  }
  return names
}

// `git ls-files` when there is a git checkout, a filesystem walk when there is
// not.
//
// This guard used to require git, which meant it could not run in the one place
// it most needs to: the deploy hook checks out into a work tree where
// `git ls-files` fails, so the first push that put the guards into the gate was
// rejected by this crashing rather than by anything it found. A guard that
// cannot run where it is meant to protect is not a guard.
//
// git is still preferred -- it excludes ignored files for free and is faster on
// a big tree -- so the fallback is only for the case where git is unavailable.
function trackedSourceFiles() {
  let rels
  try {
    rels = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
      .split('\0')
  } catch {
    rels = walkSourceFiles(ROOT)
  }
  return rels
    .filter(rel => rel && SOURCE.test(rel) && !MINIFIED.test(rel))
    .filter(rel => !LIBRARY.some(p => rel.startsWith(p)))
}

// Build output and vendored trees. The fallback approximates what git would
// have ignored, and the way to check that approximation is not "does it run" --
// it is whether it yields the SAME file set git yields. There is a comparison
// at the bottom of this file for exactly that.
//
// server/public is the built client bundle: it is .js, it constructs a
// WebSocket, and git ignores it. Without it here the fallback reports a
// violation in generated code, which is what the first gated deploy did.
const WALK_SKIP = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', 'out',
  '.venv', '__pycache__',
])
// Skipped by PATH, not by name. `server/public` is the built client bundle and
// git ignores it; top-level `public/` is tracked source -- excluding every
// directory called "public" silently dropped two real files, which the
// comparison against git's own file list is what caught.
const WALK_SKIP_PATHS = new Set(['server/public'])

function walkSourceFiles(root, prefix = '') {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (WALK_SKIP.has(entry.name)) continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (WALK_SKIP_PATHS.has(rel)) continue
    if (entry.isDirectory()) out.push(...walkSourceFiles(root, rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

const found = new Map()   // rel -> { lines: number[] }
const listeners = []      // { rel, line }

for (const rel of trackedSourceFiles()) {
  // `git ls-files` lists a file that has been deleted in the working tree but
  // not yet staged, and reading it blind crashes the whole guard -- so deleting
  // a file made the check that protects the deploy stop running entirely, which
  // is worse than any violation it could report.
  let raw
  try {
    raw = fs.readFileSync(path.join(ROOT, rel), 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') continue
    throw e
  }
  const src = stripCommentsAndStrings(raw)
  const names = socketBindings(src)

  const lineOf = (index) => src.slice(0, index).split('\n').length

  for (const m of src.matchAll(/\bnew\s+(\w+)\s*\(/g)) {
    const name = m[1]
    if (/WebSocketServer$/.test(name)) {
      listeners.push({ rel, line: lineOf(m.index) })
      continue
    }
    if (!names.has(name)) continue
    if (!found.has(rel)) found.set(rel, { lines: [] })
    found.get(rel).lines.push(lineOf(m.index))
  }
}

// --- compare against the allowlist ------------------------------------------

const violations = []

for (const [rel, { lines }] of [...found].sort()) {
  const allowed = ALLOWED[rel]
  if (!allowed) {
    violations.push(
      `${rel}: ${lines.length} WebSocket construction site(s) at line(s) ${lines.join(', ')}, outside the transport library and not listed`,
    )
    continue
  }
  if (lines.length > allowed.count) {
    violations.push(
      `${rel}: ${lines.length} construction sites (lines ${lines.join(', ')}), allowlist pins ${allowed.count}`,
    )
  }
}

const stale = []
for (const [rel, entry] of Object.entries(ALLOWED)) {
  const actual = found.get(rel)?.lines.length ?? 0
  if (actual < entry.count) stale.push(`${rel}: allowlist says ${entry.count}, found ${actual} — edit the count down`)
}

// --- report ------------------------------------------------------------------

const byCategory = { product: 0, exception: 0, tooling: 0 }
for (const [rel, { lines }] of found) {
  const cat = ALLOWED[rel]?.category
  if (cat) byCategory[cat] += lines.length
}

const productFiles = [...found.keys()].filter(rel => ALLOWED[rel]?.category === 'product').sort()

console.log('websocket-boundary-guard')
console.log(`  library: ${LIBRARY.join(', ')} (shared/resilient-ws.mjs owns the only client socket)`)
console.log('')
console.log(`  PRODUCT SITES OUTSIDE THE LIBRARY: ${byCategory.product}  <- the baseline; this is the number that should go down`)
for (const rel of productFiles) console.log(`    ${rel}:${found.get(rel).lines.join(',')}`)
console.log('')
console.log(`  exceptions (named protocols, expected to stay): ${byCategory.exception}`)
console.log(`  tooling (test and script clients): ${byCategory.tooling}`)
console.log(`  listeners, reported not blocked (new WebSocketServer): ${listeners.length}`)
for (const l of listeners) console.log(`    ${l.rel}:${l.line}`)
console.log('')
console.log('  not visible to this guard: sockets opened inside node_modules on our behalf')
console.log('  (tldraw sync / Yjs), and sockets built through a computed member or a')
console.log('  passed-in factory. The count is a lower bound.')

if (stale.length) {
  console.log('')
  console.log('  allowlist is ahead of the code — sites were removed without editing the count:')
  for (const s of stale) console.log(`    ${s}`)
}

if (violations.length) {
  console.error('')
  console.error('WebSocket constructed outside the sealed transport library:')
  for (const v of violations) console.error('  ' + v)
  console.error('')
  console.error('Go through shared/fleet-transport.mjs (Node) or shared/fleet-browser-transport.mjs')
  console.error('(browser). If this socket genuinely cannot — name the protocol and why the')
  console.error('library cannot carry it, and add an entry to ALLOWED in bin/websocket-boundary-guard.mjs.')
  console.error('An exception with no protocol named is a product site nobody has looked at yet.')
  process.exit(1)
}

process.exit(0)
