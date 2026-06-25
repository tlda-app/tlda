#!/usr/bin/env node

import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  classifyDisclosureEvent,
  extractDisclosureFeatures,
  isDisclosureCandidate,
} from './lib/todd-disclosure-classifier.mjs'

const DEFAULT_DB = path.join(os.homedir(), '.config', 'tlda', 'fleet.db')

function parseArgs(argv) {
  const args = {
    db: DEFAULT_DB,
    out: null,
    since: null,
    until: null,
    limit: 2000,
    format: 'jsonl',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--db') args.db = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--since') args.since = argv[++i]
    else if (arg === '--until') args.until = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--format') args.format = argv[++i]
    else if (arg === '--help' || arg === '-h') usage(0)
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!['jsonl', 'json'].includes(args.format)) {
    throw new Error('--format must be jsonl or json')
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive number')
  }

  return args
}

function usage(code) {
  const text = `Usage: node bin/todd-disclosure-dataset.mjs [options]

Extract candidate Todd disclosure events from the fleet SQLite event log.

Options:
  --db PATH        SQLite fleet DB (default: ~/.config/tlda/fleet.db)
  --out PATH       Write rows to PATH instead of stdout
  --since ISO      Lower timestamp bound
  --until ISO      Upper timestamp bound
  --limit N        Max chat rows to scan, newest first (default: 2000)
  --format jsonl   Output jsonl or json (default: jsonl)
`
  console.log(text.trim())
  process.exit(code)
}

function loadAgents(db) {
  const rows = db.prepare('SELECT id, friendly_name FROM agents').all()
  return new Map(rows.map(row => [row.id, row.friendly_name || row.id]))
}

function loadChatRows(db, args) {
  const where = ["type = 'chat'", 'text IS NOT NULL', "to_id = 'fleet:skip'", "from_id NOT IN ('fleet:skip', 'fleet:todd', 'fleet:tlda')"]
  const params = []

  if (args.since) {
    where.push('timestamp >= ?')
    params.push(args.since)
  }
  if (args.until) {
    where.push('timestamp <= ?')
    params.push(args.until)
  }

  params.push(args.limit)

  return db.prepare(`
    SELECT id, type, timestamp, from_id, to_id, text, metadata, task_id, agent_id
    FROM events
    WHERE ${where.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...params)
}

function rowToDisclosure(row, agents) {
  const event = {
    id: row.id,
    timestamp: row.timestamp,
    from: row.from_id,
    fromName: agents.get(row.from_id) || row.from_id,
    to: row.to_id,
    text: row.text || '',
    context: {},
  }
  const prediction = classifyDisclosureEvent(event)
  return {
    eventId: row.id,
    timestamp: row.timestamp,
    agentId: row.from_id,
    agentName: event.fromName,
    to: row.to_id,
    text: row.text || '',
    humanLabel: null,
    humanReasonCode: null,
    modelDecision: prediction.decision,
    modelReasonCode: prediction.reasonCode,
    modelConfidence: prediction.confidence,
    features: extractDisclosureFeatures(event),
    provenance: {
      getThread: `get_thread(agent: "${row.from_id}", since: "${row.timestamp}", until: "<fill bounded end>")`,
      eventId: row.id,
    },
  }
}

function formatRows(rows, format) {
  if (format === 'json') return `${JSON.stringify(rows, null, 2)}\n`
  return rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = new Database(args.db, { readonly: true, fileMustExist: true })
  const agents = loadAgents(db)
  const chatRows = loadChatRows(db, args)
  const rows = chatRows
    .filter(row => isDisclosureCandidate(row.text || ''))
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
    .map(row => rowToDisclosure(row, agents))

  const output = formatRows(rows, args.format)
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
    fs.writeFileSync(args.out, output)
  } else {
    process.stdout.write(output)
  }

  console.error(`scanned=${chatRows.length} candidates=${rows.length}`)
}

main()
