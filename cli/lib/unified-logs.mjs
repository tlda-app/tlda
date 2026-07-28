/**
 * tlda logs — unified chronological log across all sources.
 *
 * Sources:
 *   1. Fleet event API (primary)
 *   2. Daemon log file (daemon-specific: heartbeats, WS, terminal exits)
 *   3. Dead-letter JSONL (events that failed to reach DB)
 *
 * Usage:
 *   tlda logs                          # last 50 events (excluding activity/client_error)
 *   tlda logs --all                    # include activity events
 *   tlda logs --since 1h              # last hour
 *   tlda logs --since 2026-05-23      # since date
 *   tlda logs validate-contain-3      # filter by agent name (fuzzy)
 *   tlda logs --type chat,register    # filter by event type
 *   tlda logs --daemon                # include daemon log lines
 *   tlda logs -n 100                  # last 100 events
 *   tlda logs -f                      # follow (tail -f style)
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR, getFleetServerUrl, getReadToken } from '../../shared/config.mjs'
import { tldaFetch } from '../../shared/http-client.mjs'
import { formatDisplayTimestamp } from '../../shared/display-time.mjs'

const DAEMON_LOG = join(CONFIG_DIR, 'fleet-daemon.log')
const DEAD_LETTER = join(CONFIG_DIR, 'daemon-dead-letters.jsonl')

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
}

const TYPE_COLORS = {
  chat: COLORS.green,
  register: COLORS.cyan,
  deregister: COLORS.cyan,
  delegate: COLORS.blue,
  task_done: COLORS.blue,
  lifecycle: COLORS.magenta,
  compacting: COLORS.yellow,
  'kill-session': COLORS.red,
  terminal_attention: COLORS.red,
  timer: COLORS.gray,
  activity: COLORS.dim,
  client_error: COLORS.red,
  report: COLORS.magenta,
  daemon: COLORS.yellow,
  'dead-letter': COLORS.red,
}

function parseSince(val) {
  if (!val) return null
  const match = val.match(/^(\d+)(s|m|h|d)$/)
  if (match) {
    const n = parseInt(match[1])
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]
    return new Date(Date.now() - n * unit).toISOString()
  }
  const d = new Date(val)
  if (isNaN(d.getTime())) {
    console.error(`Invalid --since value: ${val}`)
    process.exit(1)
  }
  return d.toISOString()
}

function fleetApi(path) {
  return tldaFetch(path, {
    server: getFleetServerUrl(),
    token: getReadToken(),
  })
}

async function resolveAgent(query) {
  if (!query) return null
  for (const id of [query, `fleet:${query}`]) {
    const { agents } = await fleetApi(`/api/agents/lookup?ids=${encodeURIComponent(id)}`)
    if (agents?.length === 1) return agents[0]
  }
  const { agents } = await fleetApi(`/api/agents/lookup?name=${encodeURIComponent(query)}`)
  if (agents?.length === 1) return agents[0]
  throw new Error(`No unique live agent matching "${query}"`)
}

function formatEvent(ev) {
  const c = TYPE_COLORS[ev.type] || COLORS.reset
  const ts = formatDisplayTimestamp(ev.timestamp)
  const typeTag = `${c}${ev.type.padEnd(12)}${COLORS.reset}`

  let agent = ''
  if (ev.from_name || ev.from_id) {
    agent = ` ${COLORS.bold}${ev.from_name || ev.from_id}${COLORS.reset}`
  }

  let target = ''
  if (ev.to_name || ev.to_id) {
    target = ` → ${ev.to_name || ev.to_id}`
  }

  let body = ''
  if (ev.text) {
    const text = ev.text.length > 120 ? ev.text.slice(0, 117) + '...' : ev.text
    body = ` ${COLORS.dim}${text}${COLORS.reset}`
  }

  return `${COLORS.gray}${ts}${COLORS.reset} ${typeTag}${agent}${target}${body}`
}

function formatDaemonLine(line) {
  const ts = line.slice(0, 24)
  const rest = line.slice(25).replace(/^\[daemon\]\s*/, '')
  const c = COLORS.yellow
  return `${COLORS.gray}${formatDisplayTimestamp(ts)}${COLORS.reset} ${c}${'daemon'.padEnd(12)}${COLORS.reset} ${COLORS.dim}${rest}${COLORS.reset}`
}

async function queryEvents({ since, agentId, types, limit, includeActivity }) {
  const params = new URLSearchParams({
    before: String(Number.MAX_SAFE_INTEGER),
    limit: String(Math.min(5000, Math.max(limit, 50))),
  })
  if (since) params.set('since', since)
  if (agentId) params.set('agent', agentId)
  const { events = [] } = await fleetApi(`/api/store/events?${params}`)
  const allowedTypes = types?.length ? new Set(types) : null
  const sinceMs = since ? Date.parse(since) : null
  return events.filter(event => {
    if (Number.isFinite(sinceMs) && Date.parse(event.timestamp) < sinceMs) return false
    if (allowedTypes) return allowedTypes.has(event.type)
    return includeActivity || !['activity', 'client_error'].includes(event.type)
  }).slice(-limit)
}

function parseDaemonLines(since, agentFilter, limit) {
  if (!existsSync(DAEMON_LOG)) return []
  const lines = []
  const content = readFileSync(DAEMON_LOG, 'utf-8')
  const allLines = content.split('\n')

  // Only process timestamped lines (new format)
  for (let i = allLines.length - 1; i >= 0 && lines.length < limit; i--) {
    const line = allLines[i]
    if (!line || !line.match(/^\d{4}-\d{2}-\d{2}T/)) continue
    const ts = line.slice(0, 24)
    if (since && ts < since) break
    if (agentFilter && !line.includes(agentFilter)) continue
    lines.unshift(line)
  }
  return lines
}

function parseDeadLetters(since, agentFilter) {
  if (!existsSync(DEAD_LETTER)) return []
  const lines = readFileSync(DEAD_LETTER, 'utf-8').split('\n').filter(Boolean)
  const events = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      if (since && obj.ts < since) continue
      if (agentFilter && obj.agent_id !== agentFilter && !JSON.stringify(obj).includes(agentFilter)) continue
      events.push({
        timestamp: obj.ts,
        type: 'dead-letter',
        from_id: obj.agent_id || '',
        to_id: '',
        text: `${obj.type}: ${JSON.stringify(obj).slice(0, 100)}`,
        from_name: '',
        to_name: '',
      })
    } catch (e) {
      console.error(`Skipping malformed dead-letter line: ${e.message}`)
    }
  }
  return events
}

async function followLogs({ agentId, types, includeActivity }) {
  let lastId = Number((await fleetApi('/api/store/events?limit=1')).lastId || 0)

  const poll = async () => {
    const params = new URLSearchParams({ after: String(lastId), limit: '5000' })
    if (agentId) params.set('agent', agentId)
    const page = await fleetApi(`/api/store/events?${params}`)
    const allowedTypes = types?.length ? new Set(types) : null
    const rows = (page.events || []).filter(event => {
      if (allowedTypes) return allowedTypes.has(event.type)
      return includeActivity || !['activity', 'client_error'].includes(event.type)
    })
    for (const row of rows) {
      console.log(formatEvent(row))
    }
    lastId = Number(page.lastId || lastId)
  }

  console.log(`${COLORS.dim}Following logs... (Ctrl+C to stop)${COLORS.reset}`)
  await poll()
  setInterval(() => void poll(), 1000)
}

export async function cmdLogs(args) {
  const getFlag = (name) => {
    const idx = args.indexOf(`--${name}`)
    if (idx === -1) {
      const short = { n: '-n', f: '-f' }[name]
      if (short) {
        const si = args.indexOf(short)
        if (si === -1) return null
        if (name === 'f') return true
        return args[si + 1]
      }
      return null
    }
    if (['all', 'daemon', 'f', 'follow'].includes(name)) return true
    return args[idx + 1]
  }

  const since = parseSince(getFlag('since'))
  const types = getFlag('type')?.split(',')
  const includeActivity = !!getFlag('all')
  const includeDaemon = !!getFlag('daemon')
  const follow = !!getFlag('f') || !!getFlag('follow')
  const limit = parseInt(getFlag('n') || (since ? '10000' : '50'))

  // Find positional arg (agent name filter) — first arg that doesn't start with -
  let agentQuery = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('-')) {
      if (!['--all', '--daemon', '-f', '--follow'].includes(a)) i++ // skip value
      continue
    }
    agentQuery = a
    break
  }

  const agent = agentQuery ? await resolveAgent(agentQuery) : null
  const agentId = agent?.id

  if (agent) {
    console.log(`${COLORS.dim}Filtering: ${agent.friendly_name} (${agent.id})${COLORS.reset}`)
  }

  if (follow) {
    await followLogs({ agentId, types, includeActivity })
    return
  }

  // Merge sources
  const dbEvents = await queryEvents({ since, agentId, types, limit, includeActivity })
  const deadLetters = parseDeadLetters(since, agentId)

  let merged = [...dbEvents, ...deadLetters]

  if (includeDaemon) {
    const daemonLines = parseDaemonLines(since, agent?.friendly_name, limit)
    const daemonEvents = daemonLines.map(line => ({
      timestamp: line.slice(0, 24),
      _raw: line,
      _isDaemon: true,
    }))
    merged = [...merged, ...daemonEvents]
  }

  // Sort chronologically
  merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  // Trim to limit
  if (merged.length > limit) {
    merged = merged.slice(-limit)
  }

  for (const ev of merged) {
    if (ev._isDaemon) {
      console.log(formatDaemonLine(ev._raw))
    } else {
      console.log(formatEvent(ev))
    }
  }

  if (merged.length === 0) {
    console.log(`${COLORS.dim}No events found.${COLORS.reset}`)
  } else {
    console.log(`${COLORS.dim}--- ${merged.length} events ---${COLORS.reset}`)
  }

}
