// Turns scratch/task-events.json into the old-string/new-string/source-event
// mapping. Read-only; writes nothing to the store.
import { readFileSync, writeFileSync } from 'node:fs'

const rows = JSON.parse(readFileSync('scratch/task-events.json', 'utf8'))

function derivedPreFix(message) {
  const text = typeof message === 'string' ? message : ''
  const firstSentence = text.match(/^[^.!?\n]{5,60}[.!?]/)
  return firstSentence ? firstSentence[0] : text.slice(0, 60).trimEnd()
}

// Walk the delegate events in order and replay what the buggy client did, so a
// chain of hand-offs resolves to the title that existed before the FIRST of
// them. Each delegate event's `text` is the title as of just before that
// event's transfer (transferTaskLifecycle passes task.description, the old
// value). So: step back through consecutive stampings.
function recover(row) {
  const d = row.delegates || []
  if (!d.length) return { verdict: 'no-delegate-events' }
  const current = row.description || ''

  // Index of the event that wrote the current title.
  let i = d.findIndex(e => e.message && derivedPreFix(e.message) === current)
  if (i < 0) return { verdict: 'not-stamped' }

  const chain = []
  while (i >= 0) {
    const e = d[i]
    chain.push({ eventId: e.eventId, at: e.at, wrote: derivedPreFix(e.message), restoredTo: e.text })
    const prior = e.text || ''
    // Was the title this event displaced ALSO a stamp, written by an earlier
    // hand-off? If so keep walking back.
    const j = d.findIndex((x, k) => k < i && x.message && derivedPreFix(x.message) === prior)
    if (j < 0) return { verdict: 'recovered', title: prior, chain, sourceEventId: e.eventId }
    i = j
  }
  return { verdict: 'unresolved', chain }
}

const out = rows.map(r => ({ ...r, recovery: recover(r) }))
writeFileSync('scratch/title-mapping.json', JSON.stringify(out, null, 2))

const stamped = out.filter(r => r.recovery.verdict === 'recovered' || r.recovery.verdict === 'unresolved')
const recovered = out.filter(r => r.recovery.verdict === 'recovered')
const unresolved = out.filter(r => r.recovery.verdict === 'unresolved')
const empty = recovered.filter(r => !r.recovery.title.trim())

console.log(`total open tasks:      ${out.length}`)
console.log(`stamped:               ${stamped.length}`)
console.log(`  recovered exactly:   ${recovered.length - empty.length}`)
console.log(`  recovered to empty:  ${empty.length}`)
console.log(`  unresolved:          ${unresolved.length}`)
console.log(`chain length >1:       ${recovered.filter(r => r.recovery.chain.length > 1).length}`)
console.log('')
console.log('duplicate current titles among stamped rows:')
const byDesc = new Map()
for (const r of stamped) byDesc.set(r.description, (byDesc.get(r.description) || 0) + 1)
for (const [desc, n] of [...byDesc].sort((a, b) => b[1] - a[1]).filter(x => x[1] > 1)) {
  console.log(`  ${String(n).padStart(3)}  ${JSON.stringify(desc.slice(0, 64))}`)
}
