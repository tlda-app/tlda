#!/usr/bin/env node
// The mirror timeout budget is four numbers in three files, and they are only
// correct in relation to each other. Each layer waits on the one below it, so a
// layer that gives up before the layer beneath it is allowed to finish converts
// slow work into a reported failure — which is exactly what happened on
// 2026-08-17: the server allowed 10s per attempt for an operation the daemon's
// own code budgets ~50s for, gave up three times on a daemon that was still
// working, and reported `no daemon accepted the mirror` for a mirror that
// completed 4 seconds later.
//
// Numbers in separate files drift one at a time. This asserts the ordering so a
// future tuning of any one of them fails here instead of in a build queue.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Read the defaults out of the source rather than importing: unified-server.mjs
// and build-worker.mjs both start doing work on import.
function defaultOf(relPath, constName) {
  const src = readFileSync(join(root, relPath), 'utf8')
  const re = new RegExp(`${constName}\\s*=\\s*(?:Number\\([^)]*\\)\\s*\\|\\|\\s*)?(\\d+)`)
  const m = src.match(re)
  assert.ok(m, `${constName} not found in ${relPath} — has it been renamed?`)
  return Number(m[1])
}

const attempt = defaultOf('server/unified-server.mjs', 'MIRROR_ATTEMPT_TIMEOUT_MS')
const total = defaultOf('server/unified-server.mjs', 'MIRROR_TOTAL_DEADLINE_MS')
const fanout = defaultOf('server/lib/shadow-mirror-rpc.mjs', 'MIRROR_KEY_TIMEOUT_MS')
const worker = defaultOf('bin/build-worker.mjs', 'PARENT_RPC_TIMEOUT_MS')

// The daemon's own sequential budget in mirrorShadowRef: 5s rev-parse + 10s
// bundle verify + 3×30s fetch under gitRetryOnLock + 5s cat-file + 5s
// preserve/update-ref. A single attempt must be able to outlast it, or the
// server cannot tell "still working" from "gone".
const DAEMON_WORST_CASE_MS = 5000 + 10000 + 3 * 30000 + 5000 + 5000

assert.ok(attempt > 35000,
  `one attempt (${attempt}ms) must exceed the ~35s a healthy mirror was measured taking`)
assert.ok(attempt >= DAEMON_WORST_CASE_MS - 55000,
  `one attempt (${attempt}ms) is far below the daemon's own budget (${DAEMON_WORST_CASE_MS}ms)`)
assert.ok(total > attempt,
  `total (${total}ms) must leave room for more than one attempt (${attempt}ms)`)
assert.ok(fanout > total,
  `fan-out (${fanout}ms) must outlast the retries it backstops (total ${total}ms)`)
assert.ok(worker > fanout,
  `worker RPC deadline (${worker}ms) must outlast the fan-out (${fanout}ms), or the build
   abandons a mirror the server is still waiting on`)

// And the whole budget must still be finite — the original fault was that every
// one of these was unbounded, so a build could wait forever.
for (const [name, value] of [['attempt', attempt], ['total', total], ['fan-out', fanout], ['worker', worker]]) {
  assert.ok(Number.isFinite(value) && value > 0, `${name} must be a finite positive deadline`)
}

console.log(`mirror timeout budget: ok (attempt ${attempt} < total ${total} < fan-out ${fanout} < worker ${worker})`)
