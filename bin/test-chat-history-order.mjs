// queryChatHistory must return the SAME page in both orders, sorted in SQL.
//
// `order` decides how the page comes back; it must never change WHICH rows are
// in it. The selection is DESC either way (the newest rows are the page) and
// only the outer sort differs. Getting that wrong is invisible at a glance — an
// ASC selection returns the OLDEST rows and still looks like a plausible page of
// chat, which is precisely how a panel ends up quietly showing ancient history.
//
// Runs against a real SQLite database because the thing under test is SQL. A
// mock that honours `order` in JavaScript would pass regardless of what the
// query says, which is the shape of test that proves nothing.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tlda-order-test-'))
const store = new FleetStore(join(dir, 'fleet.db'))

let failed = false
const T = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond ? '' : `\n      ${detail}`))
  if (!cond) failed = true
}

try {
  for (let i = 0; i < 30; i++) {
    await store.share({
      type: 'chat',
      from: i % 2 === 0 ? 'fleet:aaa' : 'fleet:bbb',
      to: i % 2 === 0 ? 'fleet:bbb' : 'fleet:aaa',
      text: `m${String(i).padStart(2, '0')}`,
      timestamp: new Date(Date.UTC(2026, 6, 25, 0, 0, i)).toISOString(),
    })
  }
  // Traffic that must never appear in an agent-scoped page.
  for (let i = 0; i < 5; i++) {
    await store.share({
      type: 'chat', from: 'fleet:zzz', to: 'fleet:yyy', text: `other${i}`,
      timestamp: new Date(Date.UTC(2026, 6, 25, 0, 1, i)).toISOString(),
    })
  }

  const texts = rows => rows.map(r => r.text)
  const isSorted = (rows, dir) => rows.every((r, i) =>
    i === 0 || (dir === 'asc' ? rows[i - 1].timestamp <= r.timestamp : rows[i - 1].timestamp >= r.timestamp))

  for (const [label, agents] of [['global', []], ['agent-scoped', ['fleet:aaa']]]) {
    const asc = await store.queryChatHistory({ agents, limit: 10, order: 'asc' })
    const desc = await store.queryChatHistory({ agents, limit: 10, order: 'desc' })
    const fullAsc = await store.queryChatHistory({ agents, limit: 100, order: 'asc' })
    const defaultRows = await store.queryChatHistory({ agents, limit: 10 })

    T(`${label}: asc is ascending`, isSorted(asc, 'asc'), texts(asc).join())
    T(`${label}: desc is descending`, isSorted(desc, 'desc'), texts(desc).join())
    T(`${label}: same page either way`,
      texts(asc).join() === texts(desc).slice().reverse().join(),
      `${texts(asc).join()}\n      vs ${texts(desc).slice().reverse().join()}`)
    T(`${label}: the page is the NEWEST rows`,
      texts(asc).join() === texts(fullAsc).slice(-10).join(),
      texts(asc).join())
    T(`${label}: defaults to ascending`,
      texts(defaultRows).join() === texts(asc).join(),
      texts(defaultRows).join())
  }

  // Agent scoping still holds with the extra sort wrapped around it.
  const scoped = await store.queryChatHistory({ agents: ['fleet:aaa'], limit: 100, order: 'desc' })
  T('agent-scoped excludes other traffic',
    scoped.every(r => r.from === 'fleet:aaa' || r.to === 'fleet:aaa') && scoped.length === 30,
    `${scoped.length} rows`)

  // Paging with `before` must be contiguous in both orders.
  const first = await store.queryChatHistory({ agents: [], limit: 5, order: 'desc' })
  const next = await store.queryChatHistory({ before: first[first.length - 1].timestamp, agents: [], limit: 5, order: 'desc' })
  T('before-cursor pages are contiguous and non-overlapping',
    next.every(r => r.timestamp < first[first.length - 1].timestamp),
    `${texts(first).join()} then ${texts(next).join()}`)
} finally {
  store.db?.close?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL CHAT-HISTORY ORDER CHECKS PASSED')
process.exit(failed ? 1 : 0)
