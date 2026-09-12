#!/usr/bin/env node
/**
 * Backfill fleet chat events from JSONL files for the gap period (April 8 – May 14 2026).
 *
 * Extracts two kinds of events:
 *   1. Skip's messages to agents — from [from fleet:skip ...] in my_task() results
 *   2. Agent outgoing messages to Skip — from mcp__tlda__chat tool_use calls
 *
 * Usage:
 *   node bin/backfill-chat-from-jsonl.mjs [--dry-run] [--since YYYY-MM-DD] [--before YYYY-MM-DD]
 */

import { createReadStream } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, basename } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'
import Database from 'better-sqlite3'

const DRY_RUN = process.argv.includes('--dry-run')
const PROJECTS_BASE = join(homedir(), '.claude', 'projects')
const FLEET_DB = join(homedir(), '.config', 'tlda', 'fleet.db')
const LEDGER_DB = join(homedir(), '.claude', 'fleet-identity.sqlite')

const sinceIdx = process.argv.indexOf('--since')
const beforeIdx = process.argv.indexOf('--before')
const SINCE = new Date(sinceIdx >= 0 ? process.argv[sinceIdx + 1] : '2026-04-08')
const BEFORE = new Date(beforeIdx >= 0 ? process.argv[beforeIdx + 1] : '2026-05-14T12:00:00Z')

const db = new Database(FLEET_DB)
const ledger = new Database(LEDGER_DB, { readonly: true })

// session UUID → fleet ID (from identity ledger)
const sessionToFleet = new Map()
for (const row of ledger.prepare('SELECT session, fleet_id FROM sessions').all()) {
  sessionToFleet.set(row.session, row.fleet_id)
}

// friendly name → fleet ID (from fleet.db agents table)
const nameToFleet = new Map()
nameToFleet.set('skip', 'fleet:skip')
for (const row of db.prepare('SELECT id, friendly_name FROM agents').all()) {
  if (row.friendly_name) nameToFleet.set(row.friendly_name.toLowerCase(), row.id)
}

function resolveFilter(filter) {
  if (!filter?.to) return null
  const terms = filter.to
  if (terms.length === 1 && terms[0].length === 1) {
    const label = terms[0][0]
    if (label.startsWith('fleet:')) return label
    return nameToFleet.get(label.toLowerCase()) || null
  }
  return null // multi-target or complex DNF — skip
}

// Parse Skip's messages out of a my_task() tool_result text block
function parseSkipMessages(text) {
  if (!text.includes('[from fleet:skip')) return []
  const messages = []
  const parts = text.split('[from fleet:skip')
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    // Format: [viewing doc@hash]] (reply with chat(to: "fleet:skip")) <message text>
    // or:     ] (reply with chat(to: "fleet:skip")) <message text>
    const parenEnd = part.indexOf(') ')
    if (parenEnd === -1) continue
    let msgText = part.slice(parenEnd + 2)
    // Strip chatReminder line (⚠️ prefix)
    msgText = msgText.replace(/\n?⚠️[^\n]*/g, '').trim()
    if (msgText) messages.push(msgText)
  }
  return messages
}

async function scanJsonl(filePath, agentFleetId) {
  const events = []
  const skipMsgsSeen = new Set() // deduplicate repeated my_task() results

  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })

    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const obj = JSON.parse(line)
        const ts = obj.timestamp
        if (!ts) return

        const content = obj.message?.content
        if (!Array.isArray(content)) return

        for (const item of content) {
          if (!item || typeof item !== 'object') continue

          // Outgoing: agent sends a chat message
          if (agentFleetId && item.type === 'tool_use' && item.name === 'mcp__tlda__chat') {
            const inp = item.input || {}
            const text = inp.message || ''
            const toId = resolveFilter(inp.filter)
            if (text && toId) {
              events.push({ from_id: agentFleetId, to_id: toId, timestamp: ts, text })
            }
          }

          // Incoming: my_task() result containing Skip's messages
          if (agentFleetId && item.type === 'tool_result') {
            const blocks = Array.isArray(item.content) ? item.content : [item.content]
            for (const block of blocks) {
              const text = typeof block === 'object' ? (block?.text || '') : (block || '')
              if (!text.includes('📬 Messages')) continue
              for (const msg of parseSkipMessages(text)) {
                const key = msg.slice(0, 120)
                if (skipMsgsSeen.has(key)) continue
                skipMsgsSeen.add(key)
                events.push({ from_id: 'fleet:skip', to_id: agentFleetId, timestamp: ts, text: msg })
              }
            }
          }
        }
      } catch (e) { process.stderr.write(`[backfill] JSONL line parse error: ${e.message}\n`); }
    })

    rl.on('close', () => resolve(events))
    rl.on('error', () => resolve(events))
  })
}

// Deduplication: key by (from_id, to_id, text_prefix) — keep earliest timestamp
function deduplicate(events) {
  const byKey = new Map()
  for (const evt of events) {
    const key = `${evt.from_id}|${evt.to_id}|${evt.text.slice(0, 150)}`
    const existing = byKey.get(key)
    if (!existing || evt.timestamp < existing.timestamp) {
      byKey.set(key, evt)
    }
  }
  return [...byKey.values()]
}

const existsStmt = db.prepare('SELECT 1 FROM events WHERE type=? AND from_id=? AND to_id=? AND timestamp=?')
const insertStmt = db.prepare('INSERT OR IGNORE INTO events (type, timestamp, from_id, to_id, text) VALUES (?,?,?,?,?)')

async function main() {
  console.log(`Scanning JSONLs modified ${SINCE.toDateString()} – ${BEFORE.toDateString()}...`)
  if (DRY_RUN) console.log('(dry run — no changes written)\n')

  const allEvents = []
  let totalFiles = 0, processed = 0

  const projectDirs = await readdir(PROJECTS_BASE).catch(() => [])

  for (const dirName of projectDirs) {
    const dirPath = join(PROJECTS_BASE, dirName)
    let files
    try { files = await readdir(dirPath) } catch { continue }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(dirPath, file)
      let s
      try { s = await stat(filePath) } catch { continue }
      if (s.isSymbolicLink()) continue
      if (s.mtime < SINCE || s.mtime > BEFORE) continue

      totalFiles++
      const sessionId = basename(file, '.jsonl')
      const agentFleetId = sessionToFleet.get(sessionId) || null
      if (!agentFleetId) continue // skip sessions we can't map to an agent

      const events = await scanJsonl(filePath, agentFleetId).catch(() => [])
      if (events.length) allEvents.push(...events)
      processed++
    }
  }

  const deduped = deduplicate(allEvents)
  console.log(`Files in range: ${totalFiles} (${processed} with known agent IDs)`)
  console.log(`Raw events extracted: ${allEvents.length}`)
  console.log(`After deduplication: ${deduped.length}`)

  let inserted = 0, skipped = 0
  for (const evt of deduped) {
    if (DRY_RUN) {
      console.log(`  ${evt.from_id} → ${evt.to_id} @ ${evt.timestamp.slice(0,16)}: ${evt.text.slice(0,80)}`)
      inserted++
      continue
    }
    const exists = existsStmt.get('chat', evt.from_id, evt.to_id, evt.timestamp)
    if (exists) { skipped++; continue }
    insertStmt.run('chat', evt.timestamp, evt.from_id, evt.to_id, evt.text)
    inserted++
  }

  console.log(`\nResult:`)
  console.log(`  Inserted: ${inserted}`)
  console.log(`  Already existed (skipped): ${skipped}`)
}

main().catch(e => { console.error(e); process.exit(1) })
