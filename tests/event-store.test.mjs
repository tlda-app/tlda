// Unit tests for the ordered event store. Run: node tests/event-store.test.mjs
// Proves the invariants Skip cares about: no duplicates, no holes, and a clean
// tempId→dbId optimistic handoff (including the lost-reply / reconnect cases).

import { makeEventStore } from '../src/fleet/event-store.mjs'

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.error(`  FAIL ${name}`) }
}
const texts = (s) => s.all().map(e => e.text)
const ids = (s) => s.all().map(e => e._dbId ?? ('tmp:' + e._tempId))

// --- 1. Duplicate delivery of the same db event collapses to one entry ---
{
  const s = makeEventStore()
  s.upsert({ _dbId: 1, from: 'a', to: 'a', text: 'hello', timestamp: '2026-06-05T00:00:01Z', _activity: true })
  s.upsert({ _dbId: 1, from: 'a', to: 'a', text: 'hello', timestamp: '2026-06-05T00:00:01Z', _activity: true })
  check('dup same dbId → 1 entry', s.size() === 1)
  check('dup keeps the text', texts(s).join() === 'hello')
}

// --- 2. Two DISTINCT events with identical text are NOT collapsed (no hole) ---
{
  const s = makeEventStore()
  s.upsert({ _dbId: 1, text: 'same words', timestamp: '2026-06-05T00:00:01Z' })
  s.upsert({ _dbId: 2, text: 'same words', timestamp: '2026-06-05T00:00:02Z' })
  check('distinct ids, same text → 2 entries (no content-collapse)', s.size() === 2)
}

// --- 3. Chronological order regardless of arrival order (history backfill) ---
{
  const s = makeEventStore()
  s.upsert({ _dbId: 5, text: 'live-5', timestamp: '2026-06-05T00:00:05Z' })   // live arrives first
  s.upsert({ _dbId: 2, text: 'old-2', timestamp: '2026-06-05T00:00:02Z' })    // history backfill, older
  s.upsert({ _dbId: 3, text: 'old-3', timestamp: '2026-06-05T00:00:03Z' })
  check('history backfill orders chronologically', texts(s).join() === 'old-2,old-3,live-5')
  check('no holes: all three present', s.size() === 3)
}

// --- 4. Optimistic handoff: tmp then live echo (carrying tempId+dbId) → one entry ---
{
  const s = makeEventStore()
  s.upsert({ _tempId: 't1', from: 'skip', to: 'awake', text: 'hi', timestamp: '2026-06-05T00:00:09Z', _failed: false })
  check('optimistic shows immediately', s.size() === 1 && s.get('tmp:t1'))
  const { event, isNew } = s.upsert({ _dbId: 42, _tempId: 't1', from: 'skip', to: 'alice', text: 'hi', timestamp: '2026-06-05T00:00:09Z' })
  check('echo rebinds, not a new entry', isNew === false)
  check('still one entry after handoff', s.size() === 1)
  check('entry now carries dbId', event._dbId === 42)
  check('tempId cleared after handoff', event._tempId === undefined && !s.get('tmp:t1'))
  check('entry reachable by db key', s.get('db:42') === event)
  check('to rewritten to concrete recipient', event.to === 'alice')
}

// --- 5. reconcile() (WS reply) then broadcast echo → still one entry ---
{
  const s = makeEventStore()
  s.upsert({ _tempId: 't2', from: 'skip', to: 'awake', text: 'yo', timestamp: '2026-06-05T00:00:10Z' })
  s.reconcile('t2', 77, 'bob')              // WS reply binds first
  check('reconcile sets dbId', s.get('db:77') && s.get('db:77')._dbId === 77)
  s.upsert({ _dbId: 77, _tempId: 't2', from: 'skip', to: 'bob', text: 'yo', timestamp: '2026-06-05T00:00:10Z' }) // echo after
  check('broadcast echo after reconcile → still one entry', s.size() === 1)
  check('tempId gone after reconcile', !s.get('tmp:t2'))
  check('broadcast echo does not reattach tempId to db row', s.get('db:77')._tempId === undefined)
}

// --- 6. Lost-reply: reply dropped, echo arrives FIRST via tempId → one entry, flips to sent ---
{
  const s = makeEventStore()
  s.upsert({ _tempId: 't3', from: 'skip', to: 'awake', text: 'lost?', timestamp: '2026-06-05T00:00:11Z' })
  s.patchByTempId('t3', { _failed: true })  // marked "not sent" because reply never came
  check('marked failed while stranded', s.get('tmp:t3')._failed === true)
  const { event } = s.upsert({ _dbId: 91, _tempId: 't3', from: 'skip', to: 'carol', text: 'lost?', timestamp: '2026-06-05T00:00:11Z' })
  check('lost-reply echo binds the stranded entry', s.size() === 1)
  check('failed flag cleared (it actually sent)', event._failed === undefined)
  check('now has real id', event._dbId === 91)
}

// --- 7. Reconnect catch-up with persisted tempId → binds by id, no content-match needed ---
{
  const s = makeEventStore()
  s.upsert({ _tempId: 't4', from: 'skip', to: 'awake', text: 'reconnect me', timestamp: '2026-06-05T00:00:12Z' })
  // DB-replayed row now CARRIES the tempId (because we persist it on the row):
  s.upsert({ _dbId: 150, _tempId: 't4', from: 'skip', to: 'dave', text: 'reconnect me', timestamp: '2026-06-05T00:00:12Z' })
  check('reconnect echo binds by tempId, one entry', s.size() === 1 && s.get('db:150'))
}

// --- 8. A different tab's tempId never matches my optimistic entry ---
{
  const s = makeEventStore()
  s.upsert({ _tempId: 'mine', from: 'skip', to: 'awake', text: 'A', timestamp: '2026-06-05T00:00:13Z' })
  // An unrelated event with a foreign tempId + its own dbId — must NOT fold into mine.
  s.upsert({ _dbId: 200, _tempId: 'theirs', from: 'bob', to: 'skip', text: 'B', timestamp: '2026-06-05T00:00:14Z' })
  check('foreign tempId does not collide', s.size() === 2)
}

// --- 9. Flood: many events, repeated re-deliveries, nothing dropped or duplicated ---
{
  const s = makeEventStore()
  for (let i = 1; i <= 2000; i++) s.upsert({ _dbId: i, text: 'm' + i, timestamp: `2026-06-05T01:${String(i).padStart(4,'0')}Z`.replace(':0',':').slice(0,24) })
  // re-deliver every 7th event (simulating double-broadcast under load)
  for (let i = 7; i <= 2000; i += 7) s.upsert({ _dbId: i, text: 'm' + i, timestamp: '2026-06-05T01:00:00Z' })
  check('flood: no memory cap drops events', s.size() === 2000)
  const idset = new Set(ids(s))
  check('flood: no duplicate ids', idset.size === 2000)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
