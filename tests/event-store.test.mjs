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
const evictedIds = (result) => result.evicted.map(e => e._dbId ?? ('tmp:' + e._tempId))
const event = (id) => ({ _dbId: id, text: 'm' + id, timestamp: `2026-06-05T00:00:${String(id).padStart(2, '0')}Z` })
const consecutive = (xs) => xs.every((x, i) => i === 0 || x === xs[i - 1] + 1)

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

// --- 9. Flood: live append is bounded and keeps the newest contiguous tail ---
{
  const s = makeEventStore({ maxEvents: 500 })
  for (let i = 1; i <= 2000; i++) s.upsert({ _dbId: i, text: 'm' + i, timestamp: `2026-06-05T01:${String(i).padStart(4,'0')}Z`.replace(':0',':').slice(0,24) })
  // re-deliver every 7th event (simulating double-broadcast under load)
  for (let i = 7; i <= 2000; i += 7) s.upsert({ _dbId: i, text: 'm' + i, timestamp: '2026-06-05T01:00:00Z' })
  check('flood: memory cap bounds events', s.size() === 500)
  const idset = new Set(ids(s))
  check('flood: no duplicate ids inside cap', idset.size === 500)
  check('flood: keeps newest contiguous tail', ids(s)[0] === 1501 && ids(s).at(-1) === 2000 && consecutive(ids(s)))
  check('flood: evicted ids leave the key map', !s.get('db:1500') && s.get('db:1501'))
}

// --- 10. Scrollback prepends older history and evicts the newest edge ---
{
  const s = makeEventStore({ maxEvents: 5 })
  s.upsertMany([event(4), event(5), event(6), event(7), event(8)])
  const results = s.upsertMany([event(1), event(2), event(3)], { evict: 'newest' })
  check('scrollback remains capped', s.size() === 5)
  check('scrollback slides to older contiguous window', ids(s).join() === '1,2,3,4,5')
  check('scrollback reports newest-edge evictions', results.some(r => evictedIds(r).join() === '8,7,6'))
  check('scrollback evicted newest ids leave the key map', !s.get('db:6') && !s.get('db:8') && s.get('db:5'))
}

// --- 11. Live arrival after a history-shift keeps one capped chronological window ---
{
  const s = makeEventStore({ maxEvents: 5 })
  s.upsertMany([event(4), event(5), event(6), event(7), event(8)])
  s.upsertMany([event(1), event(2), event(3)], { evict: 'newest' })
  s.upsert(event(9))
  check('live after scrollback trims oldest into one chronological window', ids(s).join() === '2,3,4,5,9')
  check('live after scrollback evicted oldest id leaves the key map', !s.get('db:1') && s.get('db:2') && s.get('db:9'))
  s.upsert(event(10))
  s.upsert(event(11))
  check('new live tail keeps capped chronological window', ids(s).join() === '4,5,9,10,11')
  check('new live tail evicts oldest ids only', !s.get('db:2') && !s.get('db:3') && s.get('db:4') && s.get('db:11'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
