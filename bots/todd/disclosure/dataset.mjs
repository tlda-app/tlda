#!/usr/bin/env node

import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  classifyDisclosureEvent,
  extractDisclosureFeatures,
  isDisclosureCandidate,
} from './classifier.mjs'

const DEFAULT_DB = path.join(os.homedir(), '.config', 'tlda', 'fleet.db')
const DEFAULT_CONFIG = path.join(os.homedir(), '.config', 'tlda', 'config.json')
const INTERNAL_AGENT_IDS = new Set(['fleet:skip', 'fleet:todd', 'fleet:tlda'])

function parseArgs(argv) {
  const args = {
    source: 'sqlite',
    db: DEFAULT_DB,
    config: DEFAULT_CONFIG,
    server: null,
    token: process.env.TLDA_TOKEN_READ || process.env.TLDA_TOKEN || null,
    out: null,
    since: null,
    until: null,
    limit: 2000,
    eventLimit: 50000,
    pageSize: 5000,
    format: 'jsonl',
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source') args.source = argv[++i]
    else if (arg === '--db') args.db = argv[++i]
    else if (arg === '--config') args.config = argv[++i]
    else if (arg === '--server') args.server = argv[++i]
    else if (arg === '--token') args.token = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--since') args.since = argv[++i]
    else if (arg === '--until') args.until = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--event-limit') args.eventLimit = Number(argv[++i])
    else if (arg === '--page-size') args.pageSize = Number(argv[++i])
    else if (arg === '--format') args.format = argv[++i]
    else if (arg === '--help' || arg === '-h') usage(0)
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (!['sqlite', 'server'].includes(args.source)) {
    throw new Error('--source must be sqlite or server')
  }
  if (!['jsonl', 'json'].includes(args.format)) {
    throw new Error('--format must be jsonl or json')
  }
  if (!Number.isFinite(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive number')
  }
  if (!Number.isFinite(args.eventLimit) || args.eventLimit < 1) {
    throw new Error('--event-limit must be a positive number')
  }
  if (!Number.isFinite(args.pageSize) || args.pageSize < 1) {
    throw new Error('--page-size must be a positive number')
  }

  return args
}

function usage(code) {
  const text = `Usage: node bots/todd/disclosure/dataset.mjs [options]

Extract candidate Todd disclosure events from the fleet event log.

Options:
  --source MODE      sqlite or server (default: sqlite)
  --db PATH          SQLite fleet DB (default: ~/.config/tlda/fleet.db)
  --config PATH      tlda config for server/token defaults
  --server URL       Fleet server URL (default: config fleetServer/server)
  --token TOKEN      Read token (default: TLDA_TOKEN_READ or config tokenRead)
  --out PATH         Write rows to PATH instead of stdout
  --since ISO        Lower timestamp bound
  --until ISO        Upper timestamp bound
  --limit N          Max chat rows to scan, newest first (default: 2000)
  --event-limit N    Max raw server events to scan (default: 50000)
  --page-size N      Server page size (default: 5000)
  --format jsonl     Output jsonl or json (default: jsonl)
`
  console.log(text.trim())
  process.exit(code)
}

function readConfig(args) {
  try {
    return JSON.parse(fs.readFileSync(args.config, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

function applyConfigDefaults(args) {
  if (args.source !== 'server') return args
  const config = readConfig(args)
  args.server = args.server || config.fleetServer || config.server || config.tldaServer
  args.token = args.token || config.tokenRead || config.token

  if (!args.server) {
    throw new Error('Server source requires --server or fleetServer/server in config')
  }
  args.server = args.server.replace(/\/+$/, '')
  return args
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

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
  }
  return response.json()
}

async function loadServerAgents(args) {
  const payload = await fetchJson(`${args.server}/api/store/agents`, args.token)
  const rows = Array.isArray(payload) ? payload : payload.agents || []
  return new Map(rows.map(row => [row.id, row.friendly_name || row.name || row.id]))
}

function normalizeEventRow(event) {
  return {
    id: event.id,
    source: 'server',
    type: event.type,
    timestamp: event.timestamp,
    from_id: event.from_id || event.from,
    to_id: event.to_id || event.to,
    text: event.text || '',
    metadata: event.metadata,
    task_id: event.task_id || event.taskId,
    agent_id: event.agent_id || event.agentId,
  }
}

function isSkipFacingAgentChat(row) {
  return (
    row.type === 'chat' &&
    row.text &&
    row.to_id === 'fleet:skip' &&
    row.from_id &&
    !INTERNAL_AGENT_IDS.has(row.from_id)
  )
}

function inTimeWindow(row, args) {
  if (args.since && (row.timestamp || '') < args.since) return false
  if (args.until && (row.timestamp || '') > args.until) return false
  return true
}

async function loadServerChatRows(args) {
  const firstPage = await fetchJson(`${args.server}/api/store/events?limit=1`, args.token)
  let cursor = typeof firstPage.lastId === 'number' ? firstPage.lastId + 1 : null
  let scannedEvents = 0
  const chatRows = []

  while (scannedEvents < args.eventLimit && chatRows.length < args.limit) {
    const pageLimit = Math.min(args.pageSize, args.eventLimit - scannedEvents)
    const url = new URL(`${args.server}/api/store/events`)
    url.searchParams.set('limit', String(pageLimit))
    if (cursor !== null) url.searchParams.set('before', String(cursor))

    const payload = await fetchJson(url.toString(), args.token)
    const events = payload.events || []
    if (events.length === 0) break

    scannedEvents += events.length

    for (let i = events.length - 1; i >= 0 && chatRows.length < args.limit; i--) {
      const row = normalizeEventRow(events[i])
      if (args.since && (row.timestamp || '') < args.since) continue
      if (isSkipFacingAgentChat(row) && inTimeWindow(row, args)) {
        chatRows.push(row)
      }
    }

    cursor = events[0]?.id
    if (cursor === undefined || cursor === null) break
    if (args.since && (events[0].timestamp || '') < args.since) break
  }

  return { rows: chatRows, scannedEvents }
}

function contextWindow(timestamp) {
  const center = Date.parse(timestamp)
  if (!Number.isFinite(center)) {
    return { since: timestamp, until: '<fill bounded end>' }
  }
  return {
    since: new Date(center - 10 * 60 * 1000).toISOString(),
    until: new Date(center + 10 * 60 * 1000).toISOString(),
  }
}

function rowToDisclosure(row, agents) {
  const context = contextWindow(row.timestamp)
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
      source: row.source || 'sqlite',
      getThread: `get_thread(agent: "${row.from_id}", since: "${context.since}", until: "${context.until}", types: ["chat"])`,
      eventId: row.id,
    },
  }
}

function formatRows(rows, format) {
  if (format === 'json') return `${JSON.stringify(rows, null, 2)}\n`
  return rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '')
}

async function main() {
  const args = applyConfigDefaults(parseArgs(process.argv.slice(2)))
  let agents
  let chatRows
  let scannedEvents = null

  if (args.source === 'server') {
    agents = await loadServerAgents(args)
    const loaded = await loadServerChatRows(args)
    chatRows = loaded.rows
    scannedEvents = loaded.scannedEvents
  } else {
    const db = new Database(args.db, { readonly: true, fileMustExist: true })
    agents = loadAgents(db)
    chatRows = loadChatRows(db, args)
  }

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

  const eventStat = scannedEvents === null ? '' : ` scannedEvents=${scannedEvents}`
  console.error(`source=${args.source}${eventStat} scannedChats=${chatRows.length} candidates=${rows.length}`)
}

main().catch(error => {
  console.error(error.stack || error.message)
  process.exit(1)
})
