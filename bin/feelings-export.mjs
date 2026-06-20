#!/usr/bin/env node
// feelings-export.mjs — export Skip's fleet chat threads as JSONL and push to
// the feelings-mining Drive folder.
//
// IMPORTANT (PII): this is a SERVER-SIDE job. The server owns the events DB and
// Skip consented to the destination (his own private Drive, narrow drive.file).
// The exporting agent never reads the chat content — it writes this code; the
// server process runs it. Verify landing with `rclone ls`, never by reading the
// JSONL.
//
// Output: one JSONL record per chat message, grouped/ordered per thread, all
// participants. Shape (agreed with the feelings-mining consumer):
//   {thread_id, msg_id, ts, from, from_name, to, role, text}
// A "thread" is a conversation keyed by the non-Skip participant — matching
// get_thread(agent), which reads chat events where that agent is from_id or
// to_id. "Skip's threads" = every agent Skip has chatted with.
//
// Usage:
//   node bin/feelings-export.mjs [--db PATH] [--human fleet:skip]
//        [--since ISO] [--out PATH] [--remote feelings-drive:fleet-feelings-export]
//        [--no-push]
//
// Env equivalents: FLEET_DB, FEELINGS_HUMAN, FEELINGS_SINCE, FEELINGS_OUT,
//   FEELINGS_REMOTE.

import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'

function arg(flag, envKey, dflt) {
  const i = process.argv.indexOf(flag)
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1]
  if (envKey && process.env[envKey]) return process.env[envKey]
  return dflt
}
const hasFlag = (flag) => process.argv.includes(flag)

const DB_PATH = arg('--db', 'FLEET_DB', path.join(homedir(), '.config', 'tlda', 'fleet.db'))
const HUMAN = arg('--human', 'FEELINGS_HUMAN', 'fleet:skip')
const SINCE = arg('--since', 'FEELINGS_SINCE', null) // ISO8601; null = all history
const REMOTE = arg('--remote', 'FEELINGS_REMOTE', 'feelings-drive:fleet-feelings-export')
const OUT = arg('--out', 'FEELINGS_OUT', null) // explicit output file; else a temp file
const PUSH = !hasFlag('--no-push')

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

// Name-at-time: the friendly name a fleet id held at a given instant (newest
// qualifying span wins), so the export preserves who an agent WAS then — the
// miners anchor on that. Falls back to the agents row, then the bare id.
let nameAtStmt = null
try {
  nameAtStmt = db.prepare(`
    SELECT friendly_name FROM name_history
    WHERE fleet_id = ? AND from_ts <= ? AND (to_ts IS NULL OR to_ts > ?)
    ORDER BY from_ts DESC LIMIT 1
  `)
} catch { /* name_history may be absent (e.g. a minimal test DB) */ }
let friendlyStmt = null
try { friendlyStmt = db.prepare('SELECT friendly_name FROM agents WHERE id = ?') } catch { /* ignore */ }

const nameCache = new Map()
function nameAt(id, ts) {
  if (!id) return null
  const key = `${id}@${ts}`
  if (nameCache.has(key)) return nameCache.get(key)
  let name = null
  if (nameAtStmt) { try { name = nameAtStmt.get(id, ts, ts)?.friendly_name ?? null } catch { /* ignore */ } }
  if (!name && friendlyStmt) { try { name = friendlyStmt.get(id)?.friendly_name ?? null } catch { /* ignore */ } }
  if (!name) name = id.startsWith('fleet:') ? id.slice('fleet:'.length) : id
  nameCache.set(key, name)
  return name
}

// All chat messages where Skip is a participant (either direction). Ordered by
// thread (the non-Skip participant), then chronologically within the thread, so
// each thread reads as a contiguous, in-order exchange.
const rows = db.prepare(`
  SELECT id, timestamp, from_id, to_id, text
  FROM events
  WHERE type = 'chat'
    AND (from_id = @human OR to_id = @human)
    AND (@since IS NULL OR timestamp >= @since)
  ORDER BY CASE WHEN from_id = @human THEN to_id ELSE from_id END ASC,
           timestamp ASC, id ASC
`).all({ human: HUMAN, since: SINCE })

const records = rows.map(e => {
  const threadId = e.from_id === HUMAN ? e.to_id : e.from_id
  return {
    thread_id: threadId,
    msg_id: e.id,
    ts: e.timestamp,
    from: e.from_id,
    from_name: nameAt(e.from_id, e.timestamp),
    to: e.to_id,
    role: e.from_id === HUMAN ? 'user' : 'agent',
    text: e.text ?? '',
  }
})

const threadCount = new Set(records.map(r => r.thread_id)).size
const jsonl = records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')

const outFile = OUT || path.join(mkdtempSync(path.join(tmpdir(), 'feelings-')), 'skip-chat-threads.jsonl')
writeFileSync(outFile, jsonl)

// Stats only — never the content.
process.stderr.write(`[feelings-export] ${records.length} messages across ${threadCount} threads -> ${outFile}\n`)

if (PUSH) {
  process.stderr.write(`[feelings-export] rclone copy -> ${REMOTE}\n`)
  execFileSync('rclone', ['copy', outFile, REMOTE, '--no-traverse'], { stdio: ['ignore', 'ignore', 'inherit'] })
  process.stderr.write(`[feelings-export] pushed.\n`)
}

db.close()
// Machine-readable summary (counts only, no content) for a caller/scheduler.
process.stdout.write(JSON.stringify({ ok: true, messages: records.length, threads: threadCount, out: outFile, remote: PUSH ? REMOTE : null }) + '\n')
