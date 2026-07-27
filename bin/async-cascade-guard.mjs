#!/usr/bin/env node
// Every call site of a newly-async function must consume the Promise.
//
// WHY THIS EXISTS. The await-fleet-store lint rule catches a missed `await` on
// a fleetStore call. It cannot catch the SECOND-ORDER case: converting
// `foo()` to `async foo()` because it now awaits the store, and leaving foo's
// own callers un-awaited. That is the identical failure one level up — a
// truthy Promise whose every property is undefined, `agent.dead` reading as
// ALIVE, no throw — and it is invisible to a rule that only knows store
// methods.
//
// The store-to-worker cutover converts a lot of functions. The list of which
// ones is produced BY doing that work, so it is written down as it happens
// (ASYNC_CASCADE below) and this checks every call site of every name on it.
//
// WHAT COUNTS AS CONSUMED. The same shapes the await-fleet-store rule accepts,
// for the same reason: `await`, `return`, a concise arrow body, `.then`/
// `.catch`/`.finally`, `yield`, an element of Promise.all/allSettled/race/any,
// or an explicit `void f(…)`. `void` is allowed deliberately — it makes "I know
// this is a Promise and I am dropping it" legible in a diff, where a bare
// statement is indistinguishable from a forgotten await.
//
// Run: node bin/async-cascade-guard.mjs [--list]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as espree from 'espree'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Functions made async by the store-to-worker cutover. Append as you convert;
// an entry here turns on enforcement for that name's call sites everywhere.
//
// Matched by NAME, not by resolved binding — with one exception, below. Name
// matching over-approximates, which is the safe direction for a guard whose
// failure mode is silence.
//
// The exception is earned rather than assumed: bin/fleet-daemon.mjs declares
// its OWN synchronous ackServerDaemonOutboxMessage and
// errorServerDaemonOutboxMessage, unrelated to the server's and not imported
// from it. Six of this guard's first ten findings were those. So a file that
// DECLARES a function of the watched name is calling its own, and its call
// sites are skipped — checked per file, not configured, so it stays true when
// somebody moves a function.
export const ASYNC_CASCADE = Object.freeze([
  'refreshRuntimeRoutesForDaemon',
  'retireStaleAgentSeatBindingObligation',
  'enqueueDaemonMessage',
  'flushServerDaemonOutbox',
  'isProcessedDaemonOutboxMessage',
  'markDaemonOutboxMessageProcessed',
  'ackServerDaemonOutboxMessage',
  'errorServerDaemonOutboxMessage',
  // Converted because they enqueue through the store, which is now a boundary
  // crossing. Each one pulled its own callers with it — the express handlers
  // for backing-file register/unregister, and the project-changed global-event
  // listener — which is the second-order cascade this guard exists to catch.
  'sendWatchBackingFiles',
  'broadcastDaemonProjectsUpdated',
  'backingFileRegister',
  'backingFileUnregister',
  // The daemon-event seat authority: one store read, two exported functions,
  // four call sites across the daemon WS message handler.
  'daemonEventSeatDecision',
  'currentSeatForDaemonEvent',
  // Spawn machine routing: two fleet-pref reads at the bottom pulled
  // resolveSpawnMachine up with them, and its four call sites were all already
  // async (the spawn relay, /api/spawn, /api/agents/mint, and the availability
  // model resolver).
  'getConfiguredSpawnMachine',
  'normalizeConfiguredSpawnMachine',
  'resolveSpawnMachine',
  // Task and binding leaves, each pulled up by one or more store reads.
  'canReportTask',
  'applyNativeTaskEvents',
  'recordAgentBindingEvent',
  // The timer scheduler's whole surface: it reads pending timers and claims
  // terminals through the store, and refresh/fire/cancel call each other.
  // Receiver-qualified because these names are far too common to watch bare.
  'serverTimerScheduler.refresh',
  'serverTimerScheduler.fire',
  'serverTimerScheduler.cancel',
  'scheduler.refresh',
  'scheduler.fire',
  'scheduler.cancel',
  'this.refresh',
  'this.fire',
  // unified-server leaves, converted with every call site already async.
  'knownDaemonKeys',
  'emitTurnEnded',
  'currentSeatOrError',
  'currentSeatOrHttpError',
  'stampNames',
  'runTaskRenudgeSweep',
  'taskInboxStatusFor',
  'taskDelegateWakeText',
  'qualLoadReadsFromDb',
  // The wake path. requestWake's first act is a store read that gates every
  // branch below it, so it cannot be fire-and-forget; the two timer callers
  // are, with the reason written where they drop it.
  'requestWake',
  'inboxStatusFor',
  'chatWakeText',
  'delegateWakeText',
])

const SEARCH_DIRS = ['server', 'bin', 'cli', 'mcp-server', 'shared', 'daemon']
const PROMISE_COMBINATORS = new Set(['all', 'allSettled', 'race', 'any'])
const PROMISE_HANDLERS = new Set(['then', 'catch', 'finally'])

function sourceFiles() {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        walk(p)
      } else if (e.name.endsWith('.mjs') || e.name.endsWith('.js')) out.push(p)
    }
  }
  for (const d of SEARCH_DIRS) walk(path.join(ROOT, d))
  return out
}

// Walk with parent links so a call's context is answerable.
function* walk(node, parent = null) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) yield* walk(n, parent); return }
  if (typeof node.type !== 'string') return
  node.__parent = parent
  yield node
  for (const k of Object.keys(node)) {
    if (k === 'range' || k === 'loc' || k === '__parent') continue
    yield* walk(node[k], node)
  }
}

// An entry may be a bare name (`recordAgentBindingEvent`) or receiver-qualified
// (`serverTimerScheduler.refresh`). Qualified entries exist because some method
// names are far too common to match bare: watching `refresh`, `fire` and
// `cancel` flagged build-queue's `handle.cancel()` and a dozen unrelated calls.
// The guard's own advice is to rename rather than drop — but renaming another
// subsystem's methods from inside a threading cutover is the drive-by this
// branch is not allowed to make.
function receiverQualifiedName(callee) {
  if (callee?.type === 'ChainExpression') return receiverQualifiedName(callee.expression)
  if (callee?.type !== 'MemberExpression' || callee.computed) return null
  const prop = callee.property?.name
  if (!prop) return null
  const obj = callee.object
  const objName = obj?.type === 'Identifier' ? obj.name
    : obj?.type === 'ThisExpression' ? 'this'
    : obj?.type === 'MemberExpression' && !obj.computed ? obj.property?.name
    : null
  return objName ? `${objName}.${prop}` : null
}

function calleeName(callee) {
  if (!callee) return null
  if (callee.type === 'Identifier') return callee.name
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
    return callee.property.name
  }
  if (callee.type === 'ChainExpression') return calleeName(callee.expression)
  return null
}

function isConsumed(call) {
  // `await x?.foo()` is AwaitExpression > ChainExpression > CallExpression, so
  // the call's immediate parent is the chain, not the await. Step through it or
  // every optional call reads as unconsumed — which it did, on a line that
  // already said `await`.
  let node = call
  while (node.__parent?.type === 'ChainExpression') node = node.__parent
  const parent = node.__parent
  if (!parent) return true
  switch (parent.type) {
    case 'AwaitExpression':
    case 'ReturnStatement':
    case 'YieldExpression':
    case 'ArrowFunctionExpression':   // concise body — the promise is the value
      return true
    case 'UnaryExpression':
      return parent.operator === 'void'
    case 'MemberExpression':
      // f().then(...) / .catch / .finally
      return parent.object === node && PROMISE_HANDLERS.has(parent.property?.name)
    case 'ArrayExpression': {
      // an element of Promise.all([...]) and friends
      const gp = parent.__parent
      if (gp?.type !== 'CallExpression') return false
      const c = gp.callee
      return c?.type === 'MemberExpression'
        && c.object?.name === 'Promise'
        && PROMISE_COMBINATORS.has(c.property?.name)
    }
    // Assigned, passed as an argument, used in a condition, etc. A promise in a
    // condition is always truthy, which is the catastrophic case, so these are
    // not accepted.
    default:
      return false
  }
}

function check(files, names) {
  const watched = new Set(names)
  const findings = []
  for (const file of files) {
    let src = fs.readFileSync(file, 'utf8')
    if (src.startsWith('#!')) src = '//' + src.slice(2)   // a shebang is not module syntax
    let ast
    try {
      ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'module', range: true, loc: true })
    } catch {
      continue   // not parseable as an ES module (TS, JSX); the lint rule covers those
    }
    const lines = src.split('\n')
    // Names this file declares itself. A call to one of those resolves locally,
    // whatever the server happens to call its own function of the same name.
    const declaredHere = new Set()
    for (const node of walk(ast)) {
      if (node.type === 'FunctionDeclaration' && node.id?.name) declaredHere.add(node.id.name)
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier'
        && (node.init?.type === 'ArrowFunctionExpression' || node.init?.type === 'FunctionExpression')) {
        declaredHere.add(node.id.name)
      }
    }
    for (const node of walk(ast)) {
      if (node.type !== 'CallExpression') continue
      const bare = calleeName(node.callee)
      const qualified = receiverQualifiedName(node.callee)
      const name = watched.has(qualified) ? qualified : (watched.has(bare) ? bare : null)
      if (!name) continue
      // No import check needed alongside this: a module cannot both declare
      // and import the same binding, so declaring it settles the question.
      if (declaredHere.has(name)) continue
      // The declaration itself is not a call site.
      if (isConsumed(node)) continue
      findings.push({
        file: path.relative(ROOT, file),
        line: node.loc.start.line,
        name,
        code: (lines[node.loc.start.line - 1] || '').trim().slice(0, 100),
      })
    }
  }
  return findings
}

// ---- self-test -------------------------------------------------------------
// A guard that cannot demonstrate it rejects the bad shapes is a guard nobody
// should believe. Same discipline as await-fleet-store-guard.mjs.
function selfTest() {
  const tmp = fs.mkdtempSync(path.join(ROOT, '.async-cascade-selftest-'))
  const write = (body) => {
    const p = path.join(tmp, 'case.mjs')
    fs.writeFileSync(p, body)
    return p
  }
  const NAME = ['probeFn']
  const unsafe = [
    'probeFn(1)',
    'const x = probeFn(1)',
    'if (probeFn(1)) {}',
    'const y = { v: probeFn(1) }',
    'other(probeFn(1))',
    'const z = probeFn(1) || fallback',
    'for (const a of probeFn(1)) {}',
  ]
  const safe = [
    'async function f() { await probeFn(1) }',
    'function f() { return probeFn(1) }',
    'const f = () => probeFn(1)',
    'probeFn(1).then(() => {})',
    'probeFn(1).catch(() => {})',
    'probeFn(1).finally(() => {})',
    'void probeFn(1)',
    'async function f() { await Promise.all([probeFn(1), probeFn(2)]) }',
    'function* g() { yield probeFn(1) }',
    'async function f() { const v = await probeFn(1); return v }',
  ]
  let bad = 0
  for (const body of unsafe) {
    const p = write(`function other(){}\nconst fallback=1;\n${body}\n`)
    if (check([p], NAME).length === 0) { bad++; console.error(`  self-test: FAILED TO REJECT  ${body}`) }
  }
  for (const body of safe) {
    const p = write(`${body}\n`)
    const f = check([p], NAME)
    if (f.length !== 0) { bad++; console.error(`  self-test: WRONGLY REJECTED  ${body}`) }
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  if (bad) {
    console.error(`async-cascade guard: SELF-TEST FAILED (${bad})`)
    process.exit(2)
  }
  console.log(`async-cascade guard: rejects ${unsafe.length} unsafe shapes, allows ${safe.length} safe ones`)
}

selfTest()

if (process.argv.includes('--list')) {
  console.log(ASYNC_CASCADE.join('\n'))
  process.exit(0)
}

const findings = check(sourceFiles(), ASYNC_CASCADE)
if (!findings.length) {
  console.log(`async-cascade guard: ${ASYNC_CASCADE.length} converted functions, every call site consumes the promise`)
  process.exit(0)
}
console.error(`\nasync-cascade guard: ${findings.length} call site(s) of a now-async function do not consume its promise.`)
console.error('An un-awaited Promise is truthy with every property undefined — the same')
console.error('silent wrong-state failure as a missed store await, one level up.\n')
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}  ${f.name}()  —  ${f.code}`)
}
console.error('\nawait it, return it, .then it, or write `void` if dropping it is deliberate.')
process.exit(1)
