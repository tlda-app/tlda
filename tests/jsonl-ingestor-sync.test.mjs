import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createJsonlIngestor } from '../daemon/jsonl-ingestor.mjs'

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('overlapping session watcher syncs serialize and start one tail per JSONL', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-jsonl-sync-'))
  const jsonlPath = path.join(tmp, 'session-1.jsonl')
  fs.writeFileSync(jsonlPath, '')
  const logs = []
  const listGate = deferred()
  let listCalls = 0

  const ingestor = createJsonlIngestor({
    configDir: tmp,
    cursorsFile: path.join(tmp, 'cursors.json'),
    projectsDir: tmp,
    daemonDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin'),
    log: {
      info: msg => logs.push(['info', msg]),
      warn: msg => logs.push(['warn', msg]),
      error: msg => logs.push(['error', msg]),
    },
    sendMsg: () => true,
    sendMsgWithReply: async () => true,
    isConnected: () => true,
    isServerReady: () => true,
    getAgents: () => [],
    listSessions: async () => {
      listCalls += 1
      if (listCalls === 1) await listGate.promise
      return { sessions: ['tmux-1'] }
    },
    selectAgentKind: async () => 'fake',
    harnessAdapters: {
      fake: {
        activity: {
          kind: 'fake',
          resolveJsonl: async () => jsonlPath,
          terminalChat: false,
          backfillSearch: false,
        },
      },
    },
    permissionLedger: {},
    bufferActivity: () => true,
    extractActivityEvents: () => [],
  })

  const agent = {
    id: 'fleet:test',
    friendly_name: 'test',
    tmux_session: 'tmux-1',
    dead: false,
    cwd: tmp,
  }

  const first = ingestor.sync([agent])
  const second = ingestor.sync([agent])
  listGate.resolve()
  await Promise.all([first, second])
  ingestor.shutdown()

  const watchLogs = logs.filter(([, msg]) => /^watching fake JSONL/.test(msg))
  assert.equal(watchLogs.length, 1, JSON.stringify(logs, null, 2))
  assert.equal(listCalls, 2)
})
