#!/usr/bin/env node
import fs from 'fs'
import os from 'os'
import path from 'path'

import { getActiveConfigName, getFleetServerUrl } from '../shared/config.mjs'
import { tldaFetch } from '../shared/http-client.mjs'
import { resolveCodexResumeHandle } from '../bin/lib/codex-resume-resolver.mjs'
import { findClaudeSession, isRespawnIdentityCaughtUp } from '../bin/lib/spawn/resume.mjs'

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.config', 'tlda')

function parseArgs(argv) {
  const out = {
    server: getFleetServerUrl(),
    configName: getActiveConfigName(),
    configDir: DEFAULT_CONFIG_DIR,
    json: false,
    examples: 8,
    scope: 'hibernating',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') out.json = true
    else if (arg === '--server') out.server = argv[++i]
    else if (arg === '--config-dir') out.configDir = argv[++i]
    else if (arg === '--examples') out.examples = Number(argv[++i] || out.examples)
    else if (arg === '--scope') out.scope = argv[++i] || out.scope
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/audit-agent-resume-handles.mjs [--scope hibernating|all-active|all] [--server URL] [--config-dir DIR] [--json] [--examples N]')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!['hibernating', 'all-active', 'all'].includes(out.scope)) {
    throw new Error(`unknown --scope ${out.scope}; expected hibernating, all-active, or all`)
  }
  return out
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function metadataOf(row) {
  const parsed = parseJson(row.metadata, {})
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
}

function normalizeAgent(row) {
  const metadata = metadataOf(row)
  return {
    ...row,
    metadata,
    session_ids: parseJson(row.session_ids, []),
    labels: parseJson(row.labels, []),
    kind: row.kind || metadata.kind || null,
    model: row.model || metadata.model || null,
  }
}

function resolveKind(agent) {
  return agent.kind || null
}

function fileExists(file) {
  return !!file && fs.existsSync(file)
}

function missingBaseFields(agent, kind) {
  const missing = []
  if (!agent.id) missing.push('fleet_id')
  if (!agent.friendly_name && !agent.name) missing.push('name')
  if (!kind) missing.push('kind')
  if (!agent.model && !agent.metadata?.model) missing.push('model')
  if (!agent.cwd) missing.push('cwd')
  const ids = Array.isArray(agent.session_ids) ? agent.session_ids : []
  if (!agent.session_id && !agent.resume_id && ids.length === 0) missing.push('resume_handle')
  return missing
}

function rowSummary(agent) {
  return {
    id: agent.id,
    name: agent.friendly_name || agent.name || null,
    human: !!agent.human,
    dead: !!agent.dead || agent.status === 'dead',
    status: agent.status || null,
    machine_id: agent.machine_id || null,
    kind: agent.kind || null,
    model: agent.model || agent.metadata?.model || null,
    cwd: agent.cwd || null,
    session_id: agent.session_id || null,
    resume_id: agent.resume_id || null,
    tmux_session: agent.tmux_session || null,
    session_ids: Array.isArray(agent.session_ids) ? agent.session_ids : [],
  }
}

function inScope(agent, scope) {
  if (agent.human) return false
  if (scope === 'all') return true
  if (scope === 'all-active') return !agent.dead && agent.status !== 'dead'
  return agent.status === 'hibernating'
}

async function auditAgent(agent, options) {
  const kind = resolveKind(agent)
  const baseMissing = missingBaseFields(agent, kind)
  const base = {
    ...rowSummary(agent),
    resolved_kind: kind,
    base_missing: baseMissing,
    resolver: null,
    ok: false,
    category: null,
    reason: null,
    handle: null,
  }

  if (agent.human) {
    return { ...base, category: 'human', reason: 'human row is not respawned as an agent' }
  }
  if (agent.dead || agent.status === 'dead') {
    return { ...base, category: 'dead', reason: 'dead row is not an active hibernating respawn target' }
  }
  if (!kind) {
    return { ...base, category: 'missing-kind', reason: 'no harness kind/model from authoritative roster row' }
  }

  if (kind === 'claude') {
    const handle = findClaudeSession(agent, {
      identityConfigDir: options.configDir,
      sessionOverride: agent.session_id || undefined,
    })
    if (handle?.jsonlPath && fileExists(handle.jsonlPath)) {
      return {
        ...base,
        ok: true,
        resolver: 'findClaudeSession',
        category: 'spawnable',
        reason: 'resolved claude JSONL',
        handle: {
          kind: 'claude',
          session_id: handle.sessionId,
          path: handle.jsonlPath,
          cwd: handle.cwd || null,
        },
      }
    }
    return {
      ...base,
      resolver: 'findClaudeSession',
      category: baseMissing.includes('resume_handle') ? 'missing-resume-handle' : 'unresolvable-pointer',
      reason: isRespawnIdentityCaughtUp({ identityConfigDir: options.configDir })
        ? 'claude resolver found no on-disk JSONL for recorded identity'
        : 'identity ingestion is not caught up; resolver intentionally returned no handle',
    }
  }

  if (kind === 'codex') {
    const resolved = await resolveCodexResumeHandle(agent, {
      identityConfigDir: options.configDir,
      mode: 'daemon',
    })
    if (resolved?.ok && fileExists(resolved.jsonlPath)) {
      return {
        ...base,
        ok: true,
        resolver: 'resolveCodexResumeHandle',
        category: 'spawnable',
        reason: 'resolved codex rollout',
        handle: {
          kind: 'codex',
          session_id: resolved.resumeId,
          path: resolved.jsonlPath,
          cwd: resolved.cwd || null,
          source: resolved.source || null,
        },
      }
    }
    return {
      ...base,
      resolver: 'resolveCodexResumeHandle',
      category: baseMissing.includes('resume_handle') ? 'missing-resume-handle' : 'unresolvable-pointer',
      reason: resolved?.detail?.reason || resolved?.code || 'codex resolver found no on-disk rollout',
      handle: resolved || null,
    }
  }

  return {
    ...base,
    category: 'unsupported-kind',
    reason: `no resume resolver for harness kind ${kind}`,
  }
}

function countBy(rows, keyFn) {
  const out = {}
  for (const row of rows) {
    const key = keyFn(row) || 'unknown'
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function summarize({ allAgents, audited, results, options }) {
  const categoryCounts = countBy(results, r => r.category)
  const baseMissingCounts = {}
  for (const result of results) {
    for (const field of result.base_missing || []) {
      baseMissingCounts[field] = (baseMissingCounts[field] || 0) + 1
    }
  }
  const failureReasonCounts = {}
  for (const result of results.filter(r => !r.ok && r.category !== 'dead')) {
    const key = result.reason || result.category
    failureReasonCounts[key] = (failureReasonCounts[key] || 0) + 1
  }
  const examples = {}
  for (const result of results) {
    if (!examples[result.category]) examples[result.category] = []
    if (examples[result.category].length < options.examples) examples[result.category].push(result)
  }
  const nonHuman = allAgents.filter(a => !a.human)
  return {
    generated_at: new Date().toISOString(),
    source: {
      server: options.server,
      active_config: options.configName,
      endpoint: '/api/store/agents',
      scope: options.scope,
    },
    resolver_citations: {
      server_roster_endpoint: 'server/routes/fleet.mjs:215',
      respawn_entrypoint: 'bin/lib/spawn/index.mjs:341',
      claude_resolver: 'bin/lib/spawn/resume.mjs:145',
      codex_resolver: 'bin/lib/codex-resume-resolver.mjs:163',
    },
    totals: {
      authoritative_rows: allAgents.length,
      humans: allAgents.filter(a => a.human).length,
      non_human_agents: nonHuman.length,
      awake: nonHuman.filter(a => a.status === 'awake').length,
      hibernating: nonHuman.filter(a => a.status === 'hibernating').length,
      dead: nonHuman.filter(a => a.status === 'dead' || a.dead).length,
      audited: audited.length,
      fully_spawnable: results.filter(r => r.ok).length,
      lost_or_unresolvable_pointer: results.filter(r => r.category === 'unresolvable-pointer').length,
      missing_resume_handle: results.filter(r => r.category === 'missing-resume-handle').length,
    },
    audited_breakdown: {
      status: countBy(audited, a => a.status),
      harness: countBy(results, r => r.resolved_kind),
      category: categoryCounts,
      missing_fields: baseMissingCounts,
      failure_reasons: failureReasonCounts,
    },
    examples,
  }
}

function printText(summary) {
  console.log(`# Agent Resume Handle Audit (${summary.generated_at})`)
  console.log('')
  console.log(`Source: ${summary.source.server}${summary.source.endpoint} (active config: ${summary.source.active_config}; scope: ${summary.source.scope})`)
  console.log('')
  console.log('Resolver citations:')
  for (const [k, v] of Object.entries(summary.resolver_citations)) console.log(`- ${k}: ${v}`)
  console.log('')
  console.log('Totals:')
  for (const [k, v] of Object.entries(summary.totals)) console.log(`- ${k}: ${v}`)
  console.log('')
  console.log('Audited breakdown:')
  for (const [section, values] of Object.entries(summary.audited_breakdown)) {
    console.log(`- ${section}:`)
    if (!Object.keys(values).length) {
      console.log('  - none')
    } else {
      for (const [k, v] of Object.entries(values).sort((a, b) => b[1] - a[1])) console.log(`  - ${k}: ${v}`)
    }
  }
  console.log('')
  console.log('Examples:')
  for (const [category, rows] of Object.entries(summary.examples)) {
    console.log(`\n## ${category}`)
    for (const row of rows) {
      const handle = row.handle?.path ? ` -> ${row.handle.path}` : ''
      const fields = row.base_missing?.length ? ` [missing: ${row.base_missing.join(', ')}]` : ''
      const session = row.session_id ? ` [session_id: ${row.session_id}]` : ''
      console.log(`- ${row.id} (${row.name || 'unnamed'}): ${row.reason}${handle}${fields}${session}`)
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const rows = await tldaFetch('/api/store/agents', {
    server: options.server,
    timeoutMs: 60000,
  })
  if (!Array.isArray(rows)) throw new Error('expected /api/store/agents to return an array')
  const seen = new Set()
  const allAgents = []
  for (const row of rows) {
    if (!row.id || seen.has(row.id)) continue
    seen.add(row.id)
    allAgents.push(normalizeAgent(row))
  }
  const audited = allAgents.filter(agent => inScope(agent, options.scope))
  const results = []
  for (const agent of audited) results.push(await auditAgent(agent, options))
  const summary = summarize({ allAgents, audited, results, options })
  if (options.json) console.log(JSON.stringify({ summary, results }, null, 2))
  else printText(summary)
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err))
  process.exit(1)
})
