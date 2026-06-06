// Before/after proof for the fleet-chat freeze fix.
//
// Skip's chosen proof (NOT playwright): fire a flood of share() activity writes
// while a 20ms ticker measures whether the event loop stays responsive. The OLD
// code blocks the loop per event; the NEW code keeps it flat.
//
// Two independent causes, both fixed in the `db-write-queue` worktree:
//   1. resolveWiretaps() called getAllAgents() (~1300 agents hydrated) on EVERY
//      event — ~230ms of main-thread work per share. Fixed: look up only the
//      sender + recipient by indexed id.
//   2. the events INSERT (with FTS triggers) ran synchronously on the main
//      thread; a periodic FTS merge took ~1.5s and froze the loop. Fixed: the
//      insert runs on a writer worker thread.
//
// Run from each tree:
//   OLD: cd <main checkout>        && node <this file's path>      (imports its own fleet-store)
//   NEW: cd .worktrees/db-write-queue && node tests/write-queue-bench.mjs
// Or pass an explicit store path:  node tests/write-queue-bench.mjs /path/to/fleet-store.mjs
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const STORE = process.argv[2] || new URL('../server/lib/fleet-store.mjs', import.meta.url).pathname
const N = Number(process.env.N || 200)

const dbPath = `/tmp/wqbench-${process.pid}.db`
execSync(`cp ${process.env.HOME}/.config/tlda/fleet.db ${dbPath}`)

const { FleetStore } = await import(pathToFileURL(STORE).href)
const store = new FleetStore(dbPath)

// Warm: confirm scale we're stressing against.
console.log(`store: ${STORE}`)
console.log(`agents: ${store.getAllAgents().length}, wiretaps: ${store.getWiretaps().length}, flooding ${N} activity events\n`)

// A 20ms heartbeat = what serving fleet chat/health looks like. If share()
// holds the thread, the heartbeat is STARVED (it can't fire), and chat drops.
// We count actual fires during the flood vs how many a free loop would manage.
let maxGap = 0, fires = 0, last = Date.now()
const ticker = setInterval(() => {
  const g = Date.now() - last
  if (g > maxGap) maxGap = g
  fires++
  last = Date.now()
}, 20)

const t0 = Date.now()
for (let i = 0; i < N; i++) {
  const r = store.share({ type: 'activity', from: 'fleet:bench', to: 'fleet:bench', text: 'wqbench loop responsiveness probe ' + i })
  if (r && typeof r.then === 'function') await r   // NEW share() is async; OLD is sync
}
const total = Date.now() - t0
clearInterval(ticker)
const expectedFires = Math.floor(total / 20)

// Confirm the writes landed AND were FTS-indexed (we index everything).
await new Promise(r => setTimeout(r, 300))
const { default: Database } = await import('better-sqlite3')
const db = new Database(dbPath)
const fts = db.prepare(`SELECT count(*) c FROM events_fts WHERE events_fts MATCH 'wqbench'`).get().c
db.close()

const starved = expectedFires > 0 ? Math.round(100 * (1 - fires / expectedFires)) : 0
console.log(`total wall:        ${total}ms  (${(total / N).toFixed(2)}ms/event)`)
console.log(`heartbeat fires:   ${fires} of ~${expectedFires} expected  (${starved}% starved)  ${starved > 50 ? '← LOOP FROZE — chat/health drop' : '← loop stayed responsive'}`)
console.log(`worst single gap:  ${maxGap}ms`)
console.log(`FTS-indexed:       ${fts} / ${N}  ${fts >= N ? 'OK' : 'MISSING'}`)

execSync(`rm -f ${dbPath} ${dbPath}-shm ${dbPath}-wal ${dbPath}-journal`)
process.exit(0)
