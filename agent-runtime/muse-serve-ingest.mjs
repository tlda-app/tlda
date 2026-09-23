// Finished-turn MSP ingestion for muse serve agents.
//
// The bridge appends every raw view notification to `<stateDir>/view.jsonl`.
// This module tails that file per serve-mode muse agent and feeds ONLY
// `item/completed` notifications through the existing mapping
// (`mspViewNotificationToParserRecords`) into the SAME parser instance the
// durable path uses (`createMuseRecordParser`), then through the SAME
// `extractActivityEvents` path. No second parser, no parallel mapping —
// polish scope is finished-turn ingestion only; started/updated/turn/delta
// notifications are recorded in view.jsonl for debugging and never mapped.
//
// Wiring (in the daemon): one `createMuseServeIngest` per daemon, fed by a
// `sync(agents)` call on the same cadence as the JSONL binding reconciler.
// Each serve-mode muse agent (metadata.kind === 'muse' with a `view.jsonl`
// under its serve state dir) gets a cursor { offset, inode }; new lines are
// read, mapped, parsed, extracted, and delivered to `bufferActivity`.
//
// Ownership note: serve-mode agents also have a durable muse session (serve
// persists like the TUI), so the JSONL ingestor may ALSO tail their durable
// session file. Both feeds map to the same parser-record shapes, so a record
// arriving on both paths would produce the same event twice. The durable tail
// is authoritative when it is live: the daemon passes `isDurableTailed(agent)`
// (backed by the JSONL ingestor's watcher/ownership sync), and this module
// advances past — without emitting — any view.jsonl bytes for a
// durable-tailed agent. The serve feed covers only agents the durable tail
// does not. Every emitted event carries a stable `muse-serve:` operation
// identity (agent + synthetic record id + creation index) so the server's
// activity duplicate guard collapses serve-vs-serve replays (restart
// re-reads) the same way it collapses the muse-history backfill twins.

import fs from 'node:fs'
import path from 'node:path'
import { harnessKindForAgent } from './daemon-guards.mjs'
import { serveStateDir } from './muse-serve-host.mjs'
import { mspViewNotificationToParserRecords } from './muse-serve-events.mjs'
import { createMuseRecordParser } from './muse-activity.mjs'
import { extractActivityEvents } from '../daemon/activity-events.mjs'

export function museServeOperationStamper({ agentId, recordKey }) {
  if (!agentId || recordKey == null || recordKey === '') return undefined
  // Stable across re-reads of the same view.jsonl line (restart replays hit
  // the same identity, so the server's activity duplicate guard collapses
  // them); unique per logical row via the synthetic record id + creation
  // index, mirroring the muse-history stamper's shape in its own keyspace.
  // Deferred emissions keep their creation stamp via the extractor, so the
  // terminal's identity survives its result arriving on a later record.
  return { operationIdFor: index => `muse-serve:${agentId}:${recordKey}:${index}` }
}

export function createMuseServeIngest({ bufferActivity, log = console, isDurableTailed = null } = {}) {
  if (!bufferActivity) throw new Error('muse serve ingest requires bufferActivity')
  const cursors = new Map()
  const parsers = new Map()

  function parserFor(agentId) {
    let parse = parsers.get(agentId)
    if (!parse) {
      parse = createMuseRecordParser()
      parsers.set(agentId, parse)
    }
    return parse
  }

  function ingestAgent(agent) {
    const agentId = agent?.id
    if (!agentId) return
    let kind
    try {
      kind = harnessKindForAgent(agent, log)
    } catch {
      return
    }
    if (kind !== 'muse') return
    const tmuxSession = agent.tmuxSession || agent.tmux_session
    if (!tmuxSession) return
    const viewPath = path.join(serveStateDir(tmuxSession), 'view.jsonl')
    let stat
    try {
      stat = fs.statSync(viewPath)
    } catch {
      return
    }
    const cursor = cursors.get(agentId) || { offset: 0, inode: stat.ino }
    if (cursor.inode !== stat.ino) {
      cursor.inode = stat.ino
      cursor.offset = 0
    }
    if (stat.size <= cursor.offset) {
      cursors.set(agentId, cursor)
      return
    }
    // The durable tail owns this agent's rows while it watches the durable
    // session file. Advance past the serve bytes without emitting so a later
    // durable outage resumes the serve feed from EOF — never by re-emitting
    // rows the durable tail already delivered.
    let durable = false
    try {
      durable = !!isDurableTailed?.(agent)
    } catch {
      // Ownership lookup failure must not stall the reconcile batch; fall
      // back to emitting (a duplicate row dedupes server-side, a dropped
      // row is lost).
      durable = false
    }
    if (durable) {
      cursor.offset = stat.size
      cursors.set(agentId, cursor)
      return
    }
    let text
    try {
      const fd = fs.openSync(viewPath, 'r')
      try {
        const length = stat.size - cursor.offset
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, cursor.offset)
        text = buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    cursor.offset = stat.size
    cursors.set(agentId, cursor)
    const parse = parserFor(agentId)
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const records = mspViewNotificationToParserRecords(msg)
      for (const record of records) {
        const ev = parse(record)
        if (!ev) continue
        const activity = extractActivityEvents(
          [ev],
          museServeOperationStamper({ agentId, recordKey: record?.id }),
        )
        if (activity.length > 0) bufferActivity(agentId, activity)
      }
    }
  }

  function sync(agents) {
    for (const agent of agents || []) {
      try {
        ingestAgent(agent)
      } catch (err) {
        // One agent's corrupt view.jsonl line must not stall the rest of the
        // reconcile batch; the cursor only advances past parsed bytes.
        log.warn(`muse serve ingest failed for ${agent?.id}: ${err?.message || err}`)
      }
    }
    // Drop state for agents that are gone so parsers and cursors do not leak.
    const live = new Set((agents || []).map(agent => agent?.id).filter(Boolean))
    for (const id of [...cursors.keys()]) {
      if (!live.has(id)) {
        cursors.delete(id)
        parsers.delete(id)
      }
    }
  }

  return { sync, ingestAgent }
}
