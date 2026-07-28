#!/usr/bin/env node
/**
 * Backfill metadata.kind on fleet agent rows.
 *
 * For live agents, infer the kind from the tmux pane's process tree when
 * possible. Unresolved rows are skipped unless --kind or --default-kind is
 * supplied, so this script does not silently turn Codex/Goose rows into Claude.
 *
 * Usage:
 *   node bin/backfill-harness-kind.mjs [--dry-run] [--default-kind claude]
 *   node bin/backfill-harness-kind.mjs --agent fleet:abc12345 --kind codex
 *   node bin/backfill-harness-kind.mjs --db ~/.config/tlda/fleet.db --dry-run
 */

import { execFileSync } from 'child_process'
import Database from 'better-sqlite3'
import { homedir } from 'os'
import { getFleetServerUrl, getRwToken } from '../shared/config.mjs'

const VALID_KINDS = new Set(['claude', 'codex', 'goose'])

function parseArgs(argv) {
  const args = { dryRun: false, agent: null, kind: null, defaultKind: null, db: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--agent') args.agent = argv[++i]
    else if (arg === '--kind') args.kind = argv[++i]
    else if (arg === '--default-kind') args.defaultKind = argv[++i]
    else if (arg === '--db') args.db = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node bin/backfill-harness-kind.mjs [--dry-run] [--agent AGENT --kind claude|codex|goose] [--default-kind claude|codex|goose] [--db PATH]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  for (const [name, value] of [['kind', args.kind], ['default-kind', args.defaultKind]]) {
    if (value && !VALID_KINDS.has(value)) {
      throw new Error(`unknown ${name} "${value}" (valid: ${[...VALID_KINDS].join(', ')})`)
    }
  }
  return args
}

async function request(path, { method = 'GET', body = null } = {}) {
  const server = getFleetServerUrl()
  const headers = {}
  const token = getRwToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${server}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = text }
  if (!res.ok) {
    const msg = typeof data === 'object' ? data?.error || text : text
    throw new Error(msg || `HTTP ${res.status}`)
  }
  return data
}

async function requestAllAgents() {
  const agents = []
  let cursor = null
  do {
    const params = new URLSearchParams({ limit: '200' })
    if (cursor) params.set('cursor', cursor)
    const page = await request(`/api/agents?${params}`)
    agents.push(...(page.agents || []))
    cursor = page.nextCursor || null
  } while (cursor)
  return agents
}

function expandPath(p) {
  if (!p) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return `${homedir()}${p.slice(1)}`
  return p
}

function parseMetadata(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    const meta = JSON.parse(raw)
    return meta && typeof meta === 'object' ? meta : {}
  } catch {
    return {}
  }
}

function loadAgentsFromDb(dbPath) {
  const db = new Database(expandPath(dbPath), { readonly: true })
  try {
    return db.prepare('SELECT id, friendly_name, tmux_session, dead, metadata FROM agents ORDER BY last_seen DESC')
      .all()
      .map(agent => ({ ...agent, metadata: parseMetadata(agent.metadata) }))
  } finally {
    db.close()
  }
}

function writeKindToDb(dbPath, agentId, kind) {
  const db = new Database(expandPath(dbPath))
  try {
    const row = db.prepare('SELECT metadata FROM agents WHERE id = ?').get(agentId)
    if (!row) throw new Error(`agent not found: ${agentId}`)
    const metadata = { ...parseMetadata(row.metadata), kind }
    db.prepare('UPDATE agents SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), agentId)
  } finally {
    db.close()
  }
}

function metadataModel(agent) {
  return agent?.metadata?.model || ''
}

function kindFromModel(agent) {
  const model = metadataModel(agent)
  if (model.startsWith('claude-')) return 'claude'
  if (model) return 'goose'
  return null
}

function processRows() {
  try {
    return execFileSync('ps', ['-eo', 'pid,ppid,args'], { encoding: 'utf8', timeout: 5000 })
      .split('\n')
      .map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter(Boolean)
      .map(([, pid, ppid, args]) => ({ pid, ppid, args }))
  } catch {
    return []
  }
}

const PROC_ROWS = processRows()
const CHILDREN = new Map()
for (const row of PROC_ROWS) {
  if (!CHILDREN.has(row.ppid)) CHILDREN.set(row.ppid, [])
  CHILDREN.get(row.ppid).push(row.pid)
}
const ARGS_BY_PID = new Map(PROC_ROWS.map(row => [row.pid, row.args]))
let TMUX_USABLE = null

function panePids(session) {
  if (!session) return []
  if (TMUX_USABLE === false) return []
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      encoding: 'utf8',
      timeout: 1000,
      env: { ...process.env, TMUX: '' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    TMUX_USABLE = true
    return out.trim().split(/\s+/).filter(Boolean)
  } catch {
    TMUX_USABLE = false
    return []
  }
}

function kindFromRuntime(agent) {
  const roots = panePids(agent.tmux_session)
  const stack = [...roots]
  const seen = new Set()
  while (stack.length) {
    const pid = stack.pop()
    if (!pid || seen.has(pid)) continue
    seen.add(pid)
    const args = ARGS_BY_PID.get(pid) || ''
    if (/(?:^|\s|\/)codex(?:\s|$)/.test(args)) return 'codex'
    if (/(?:^|\s|\/)goose(?:\s|$).*?\brun\b|\bgoose run\b/.test(args)) return 'goose'
    if (/(?:^|\s|\/)claude(?:\s|$)/.test(args)) return 'claude'
    for (const child of CHILDREN.get(pid) || []) stack.push(child)
  }
  return null
}

function inferKind(agent, args) {
  if (args.kind) return { kind: args.kind, reason: 'explicit' }
  const runtimeKind = kindFromRuntime(agent)
  if (runtimeKind) return { kind: runtimeKind, reason: 'runtime' }
  const modelKind = kindFromModel(agent)
  if (modelKind) return { kind: modelKind, reason: 'model' }
  if (args.defaultKind) return { kind: args.defaultKind, reason: 'default' }
  return { kind: null, reason: 'unresolved' }
}

const args = parseArgs(process.argv.slice(2))
const agents = args.db ? loadAgentsFromDb(args.db) : await requestAllAgents()
const candidates = agents.filter(agent => {
  if (args.agent && agent.id !== args.agent && agent.friendly_name !== args.agent) return false
  return !agent.metadata?.kind
})

if (args.agent && candidates.length === 0) {
  console.log(`No missing metadata.kind row matched ${args.agent}`)
  process.exit(0)
}

let updated = 0
let skipped = 0
const counts = new Map()
for (const agent of candidates) {
  const label = agent.friendly_name ? `${agent.friendly_name} (${agent.id})` : agent.id
  const inferred = inferKind(agent, args)
  if (!inferred.kind) {
    skipped += 1
    console.log(`skip ${label}: unresolved kind (rerun with --default-kind after review)`)
    continue
  }
  counts.set(`${inferred.kind}/${inferred.reason}`, (counts.get(`${inferred.kind}/${inferred.reason}`) || 0) + 1)
  if (args.dryRun) {
    console.log(`would set ${label} metadata.kind=${inferred.kind} (${inferred.reason})`)
    continue
  }
  if (args.db) writeKindToDb(args.db, agent.id, inferred.kind)
  else {
    await request('/api/set-metadata', {
      method: 'POST',
      body: { agent: agent.id, kind: inferred.kind },
    })
  }
  updated += 1
  console.log(`set ${label} metadata.kind=${inferred.kind} (${inferred.reason})`)
}

const action = args.dryRun ? 'would update' : 'updated'
console.log(`${action} ${args.dryRun ? candidates.length - skipped : updated} agent(s), skipped ${skipped}`)
console.log(JSON.stringify(Object.fromEntries([...counts.entries()].sort()), null, 2))
