#!/usr/bin/env node
/**
 * backfill-agent-models.mjs — one-shot fill of `metadata.model` for agents that
 * were minted without one.
 *
 * Why these rows are empty: the daemon's seat request used to forward the model
 * the SPAWNER ASKED FOR, and `agent-launch/register.mjs` writes `metadata.model`
 * only when it is given a value. A mint that named no model still resolved a
 * modelSpec and launched on it, so it reached the roster with no model at all —
 * and the agents panel expansion, which has a model chip, had nothing to render.
 * `bin/fleet-daemon.mjs` now sends the resolved alias, but only for mints after
 * that change. This fills in the ones already on the roster.
 *
 * The model is a daemon fact, and this reads it from the daemon's own record:
 * `daemon-mints.sqlite`, where `launch_recipe.modelSpec.alias` is the spec the
 * daemon resolved and launched. It never invents one and never overwrites a
 * model a row already has — the server's `agent-model` handler is fill-only for
 * the same reason.
 *
 *   node scripts/backfill-agent-models.mjs            # report what it would fill
 *   node scripts/backfill-agent-models.mjs --apply    # send the fills
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { WebSocket } from 'ws'
import { apiJson, resolveApi, tlsOptionsForApi } from '../agent-launch/register.mjs'

const APPLY = process.argv.includes('--apply')
const MINT_DB = process.env.TLDA_DAEMON_MINTS
  || path.join(os.homedir(), '.config', 'tlda', 'daemon-mints.sqlite')

function resolvedModelsByFleetId() {
  if (!fs.existsSync(MINT_DB)) throw new Error(`no daemon mint store at ${MINT_DB}`)
  const db = new Database(MINT_DB, { readonly: true })
  try {
    const rows = db.prepare(`
      SELECT fleet_id,
             friendly_name,
             json_extract(launch_recipe, '$.modelSpec.alias') AS alias
      FROM daemon_mints
      WHERE fleet_id IS NOT NULL
        AND json_extract(launch_recipe, '$.modelSpec.alias') IS NOT NULL
    `).all()
    return new Map(rows.map(row => [row.fleet_id, row.alias]))
  } finally {
    db.close()
  }
}

async function liveAgents() {
  const agents = []
  let cursor = null
  for (;;) {
    const query = `/api/agents?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page = await apiJson(query, { timeoutMs: 15000 })
    agents.push(...(page.agents || []))
    if (!page.nextCursor) return agents
    cursor = page.nextCursor
  }
}

// One socket for the whole run: the server's `agent-model` handler replies per
// message, so the fills are confirmed individually rather than fired blind.
function sendFills(fills) {
  const api = resolveApi()
  const wsUrl = `${api.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/ws/fleet?agent=${encodeURIComponent('backfill-agent-models')}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, tlsOptionsForApi(api))
    const pending = new Map()
    const results = []
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* the timeout is the reported outcome */ }
      reject(new Error(`backfill timed out with ${pending.size} reply(ies) outstanding`))
    }, 60000)
    ws.on('open', () => {
      for (const fill of fills) {
        const id = randomUUID()
        pending.set(id, fill)
        ws.send(JSON.stringify({ type: 'agent-model', id, agent_id: fill.id, model: fill.model }))
      }
    })
    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      const fill = pending.get(msg.id)
      if (!fill) return
      pending.delete(msg.id)
      const failure = msg.error ? (msg.error.message || String(msg.error)) : null
      results.push({ ...fill, filled: !!msg.result?.filled, error: failure })
      if (pending.size) return
      clearTimeout(timer)
      try { ws.close() } catch { /* results are already collected */ }
      resolve(results)
    })
    ws.on('error', e => { clearTimeout(timer); reject(e) })
  })
}

const resolved = resolvedModelsByFleetId()
const agents = await liveAgents()
const missing = agents.filter(agent => !agent.dead && !agent.metadata?.model)
const fills = missing
  .map(agent => ({ id: agent.id, name: agent.friendly_name || agent.id, model: resolved.get(agent.id) }))
  .filter(fill => fill.model)
const unknown = missing.length - fills.length

console.log(`${agents.length} live agents, ${missing.length} with no model, ${fills.length} the daemon can name`)
for (const fill of fills) console.log(`  ${fill.name} → ${fill.model}`)
// Named, not swallowed: an agent this machine never minted has no record here,
// and that is a different fact from having nothing to fill.
if (unknown) console.log(`  (${unknown} not minted by this daemon's store — nothing to fill them from)`)

if (!APPLY) {
  console.log('\ndry run; pass --apply to send these')
  process.exit(0)
}

const results = await sendFills(fills)
const filled = results.filter(result => result.filled)
const skipped = results.filter(result => !result.filled && !result.error)
const failed = results.filter(result => result.error)
console.log(`\nfilled ${filled.length}, already had a model ${skipped.length}, failed ${failed.length}`)
for (const failure of failed) console.log(`  ${failure.name}: ${failure.error}`)
process.exit(failed.length ? 1 : 0)
