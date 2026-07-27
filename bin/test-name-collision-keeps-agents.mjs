// A friendly-name collision must RENAME the loser, never kill it.
//
// Skip: "Nothing should kill an agent, ever, other than a manual operation" and
// "the name rotation doesn't kill an agent -- it wipes their name, but it
// doesn't kill them."
//
// This dedupe runs inside schema init, before the unique index is created, on
// Skip's live 7,000-agent database. Two things must hold or the server does not
// start: it must leave exactly one live holder per name, and it must not be able
// to throw. The old code guaranteed both by marking losers dead -- which is the
// duplicate-chief failure, a live agent killed for sharing a name.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { FleetStore } from '../server/lib/fleet-store.mjs'

let failed = false
const T = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond ? '' : `\n      ${detail}`))
  if (!cond) failed = true
}

const dir = mkdtempSync(join(tmpdir(), 'tlda-collide-'))
const dbPath = join(dir, 'fleet.db')

try {
  // Build a database that already contains collisions, the way a real one does:
  // open it once so the schema exists, close, then insert duplicates behind the
  // store's back and reopen so the dedupe path runs on startup.
  new FleetStore(dbPath).db.close()

  const raw = new Database(dbPath)
  // Drop the live-name index so duplicates can be inserted at all. This is not
  // a contrivance — it is precisely the state the dedupe exists for: a database
  // written before the index, being opened by a build that has it.
  raw.exec('DROP INDEX IF EXISTS idx_agents_live_name')
  raw.prepare('DELETE FROM agents').run()
  const ins = raw.prepare(
    "INSERT INTO agents (id, friendly_name, session_id, last_seen, dead) VALUES (?, ?, ?, ?, 0)"
  )
  // Three live agents called todd. The oldest-seen are the ones the old code killed.
  ins.run('fleet:aaa', 'todd', 'sess-a', '2026-07-25T10:00:00Z')
  ins.run('fleet:bbb', 'todd', 'sess-b', '2026-07-25T09:00:00Z')
  ins.run('fleet:ccc', 'todd', 'sess-c', '2026-07-25T08:00:00Z')
  // A pair whose name cannot rotate: 'a' has no earlier letter to fall back to.
  ins.run('fleet:ddd', 'a', 'sess-d', '2026-07-25T10:00:00Z')
  ins.run('fleet:eee', 'a', 'sess-e', '2026-07-25T09:00:00Z')
  raw.close()

  // Reopen — this is the startup path under test.
  const store = new FleetStore(dbPath)
  const all = store.db.prepare('SELECT id, friendly_name, dead FROM agents ORDER BY id').all()

  T('nobody was killed', all.every(r => r.dead === 0),
    all.filter(r => r.dead !== 0).map(r => `${r.id}(${r.friendly_name})`).join(', '))
  T('every agent still exists', all.length === 5, `${all.length} rows`)

  const byId = Object.fromEntries(all.map(r => [r.id, r.friendly_name]))
  T('the most-recently-seen keeps the name', byId['fleet:aaa'] === 'todd', String(byId['fleet:aaa']))
  T('the losers rotated off it',
    byId['fleet:bbb'] !== 'todd' && byId['fleet:ccc'] !== 'todd',
    `bbb=${byId['fleet:bbb']} ccc=${byId['fleet:ccc']}`)
  T('rotation is the first-letter-back rule',
    byId['fleet:bbb'] === 'sodd' || byId['fleet:ccc'] === 'sodd',
    `bbb=${byId['fleet:bbb']} ccc=${byId['fleet:ccc']}`)

  // The unrotatable pair: one keeps 'a', the other must be nameless — NOT dead.
  T('an unrotatable name is cleared, not killed',
    byId['fleet:ddd'] === 'a' && (byId['fleet:eee'] === null || byId['fleet:eee'] !== 'a'),
    `ddd=${byId['fleet:ddd']} eee=${byId['fleet:eee']}`)

  // The invariant the index needs: one live holder per non-null name.
  const dupes = store.db.prepare(`
    SELECT friendly_name, COUNT(*) c FROM agents
    WHERE dead = 0 AND friendly_name IS NOT NULL
    GROUP BY friendly_name HAVING c > 1
  `).all()
  T('one live holder per name', dupes.length === 0, JSON.stringify(dupes))

  // hasEverRun: the carve-out Skip named -- a reservation that never launched.
  T('an agent with a session has run', await store.hasEverRun('fleet:aaa') === true, 'false')
  raw2: {
    const r2 = new Database(dbPath)
    r2.prepare("INSERT INTO agents (id, friendly_name, last_seen, dead) VALUES ('fleet:never', 'never', '2026-07-25T10:00:00Z', 0)").run()
    r2.close()
  }
  const store2 = new FleetStore(dbPath)
  T('a reservation that never launched has NOT run', await store2.hasEverRun('fleet:never') === false, 'true')
  store2.db.close()
  store.db.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL NAME-COLLISION CHECKS PASSED')
process.exit(failed ? 1 : 0)
