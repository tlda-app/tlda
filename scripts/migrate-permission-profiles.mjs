#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const APPLY = process.argv.includes('--apply')
const DB = process.env.TLDA_PERMISSION_DB
  || path.join(os.homedir(), '.config', 'tlda', 'fleet-daemon.db')

const VALID = new Set(['wd', 'math', 'app-dev', 'ops'])

function targetProfile(row) {
  const old = row.permission_profile
  if (VALID.has(old)) return null
  if (old === 'cwd' || old === 'write' || old === 'read') return 'wd'
  if (old === 'full' || old === 'break-glass') return 'ops'
  if (old === 'unsandboxed') {
    const name = String(row.friendly_name || '').toLowerCase()
    const cwd = String(row.cwd || '')
    if (name === 'yolo' || name.includes('ops') || name.includes('launchd') || name.includes('chief')) return 'ops'
    if (cwd.startsWith('/Users/skip/work/ops')) return 'ops'
    return 'app-dev'
  }
  if (old === 'none') return 'wd'
  return null
}

const db = new Database(DB)
db.pragma('busy_timeout = 5000')

const rows = db.prepare(`
  SELECT la.local_agent_id, la.server_agent_id, la.friendly_name,
         lap.permission_profile, lap.cwd
  FROM local_agents la
  JOIN local_agent_process_recipes lap USING(local_agent_id)
  ORDER BY COALESCE(la.friendly_name, la.server_agent_id)
`).all()

const changes = []
const unresolved = []
for (const row of rows) {
  const target = targetProfile(row)
  if (!target) {
    if (!VALID.has(row.permission_profile)) unresolved.push(row)
    continue
  }
  changes.push({ ...row, target })
}

console.log(`db=${DB}`)
console.log(`mode=${APPLY ? 'apply' : 'dry-run'}`)
console.log(`changes=${changes.length}`)
console.log(`unresolved=${unresolved.length}`)
for (const row of changes) {
  console.log([
    'CHANGE',
    row.server_agent_id || row.local_agent_id,
    row.friendly_name || '',
    row.permission_profile || '(null)',
    '=>',
    row.target,
    row.cwd || '',
  ].join('\t'))
}
for (const row of unresolved) {
  console.log([
    'UNRESOLVED',
    row.server_agent_id || row.local_agent_id,
    row.friendly_name || '',
    row.permission_profile || '(null)',
    row.cwd || '',
  ].join('\t'))
}

if (APPLY) {
  const update = db.prepare(`
    UPDATE local_agent_process_recipes
    SET permission_profile = ?
    WHERE local_agent_id = ?
      AND permission_profile = ?
  `)
  const tx = db.transaction(() => {
    for (const row of changes) update.run(row.target, row.local_agent_id, row.permission_profile)
  })
  tx()
  console.log(`applied=${changes.length}`)
} else {
  console.log('dry-run only; rerun with --apply after approval')
}

db.close()
