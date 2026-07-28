// Chat history is conversation, not telemetry. Diagnostic event rows must not
// consume conversation pages before the renderer gets a chance to drop them.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tlda-chat-telemetry-test-'))
const store = new FleetStore(join(dir, 'fleet.db'))

let failed = false
const T = (name, cond, detail = '') => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond ? '' : `\n      ${detail}`))
  if (!cond) failed = true
}

const ts = second => new Date(Date.UTC(2026, 6, 25, 12, 0, second)).toISOString()

try {
  await store.share({
    type: 'chat',
    from: 'fleet:skip',
    to: 'fleet:agent',
    text: 'real human chat',
    timestamp: ts(1),
  })

  for (let i = 2; i < 12; i++) {
    await store.share({
      type: 'notification_attempt',
      from: i % 2 === 0 ? 'fleet:tlda' : 'fleet:agent',
      to: i % 2 === 0 ? 'fleet:agent' : 'fleet:tlda',
      text: `notification attempted ${i}`,
      timestamp: ts(i),
      unread: false,
    })
  }

  const global = await store.queryChatHistory({ agents: [], limit: 1, order: 'desc' })
  T('global chat history skips newer notification_attempt rows',
    global.length === 1 && global[0].type === 'chat' && global[0].text === 'real human chat',
    JSON.stringify(global))

  const scoped = await store.queryChatHistory({ agents: ['fleet:agent'], limit: 1, order: 'desc' })
  T('agent-scoped chat history skips newer notification_attempt rows',
    scoped.length === 1 && scoped[0].type === 'chat' && scoped[0].text === 'real human chat',
    JSON.stringify(scoped))

} finally {
  store.db?.close?.()
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL CHAT-HISTORY TELEMETRY CHECKS PASSED')
process.exit(failed ? 1 : 0)
