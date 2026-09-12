import { readFileSync, writeFileSync } from 'node:fs'

const rows = JSON.parse(readFileSync('scratch/title-mapping.json', 'utf8'))
  .filter(r => r.recovery.verdict === 'recovered')

const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ⏎ ')

const groups = new Map()
for (const r of rows) {
  const key = r.description
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}
const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))

const out = ['# Title restore mapping — all 87 stamped rows', '']
out.push(`Read from the testing store at ${new Date().toISOString()}. Source for every row is a`)
out.push('delegate event, read directly off `events.text` for that `task_id`. No timestamp join,')
out.push('no reconstruction. Nothing has been written.', '')
out.push('**How the source is exact.** `transferTaskLifecycle` emits its delegate event with')
out.push('`task.description` — the value *before* the transfer overwrites it. So the event that')
out.push('wrote a stamped title also carries, in its own `text`, the title it displaced. Where a')
out.push('row was handed off more than once, the walk steps back through each consecutive stamp;')
out.push('`chain` is how many hops. `event` is the id whose `text` is the restored string —')
out.push('check any of them with `thread(message_id: <id>)`.', '')
out.push(`**Groups: ${ordered.length}.** A group is one bulk hand-off; every row in it currently reads the same.`, '')

for (const [current, members] of ordered) {
  out.push(`## ${members.length} row${members.length > 1 ? 's' : ''} now reading “${esc(current)}”`, '')
  out.push('| task | restore to | event | chain |')
  out.push('|---|---|---|---|')
  for (const m of members.sort((a, b) => a.id.localeCompare(b.id))) {
    out.push(`| \`${m.id}\` | ${esc(m.recovery.title)} | ${m.recovery.sourceEventId} | ${m.recovery.chain.length} |`)
  }
  out.push('')
}

writeFileSync('scratch/title-restore-mapping.md', out.join('\n'))
console.log(`wrote ${rows.length} rows in ${ordered.length} groups`)
