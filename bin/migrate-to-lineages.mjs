#!/usr/bin/env node

/**
 * One-time migration: create lineages from existing agent friendly_names.
 *
 * For each existing agent with a unique friendly_name:
 *   - Create a lineage with that name
 *   - Most-recently-seen non-dead agent → phase = 'day'
 *   - Hibernating/dead siblings with the same name are left clean (no lineage_id)
 *     — reachable by fleet:<id> only. No synthetic history fabricated.
 *
 * Usage:
 *   node bin/migrate-to-lineages.mjs                  # live run against fleet.db
 *   node bin/migrate-to-lineages.mjs --dry-run        # show what would happen
 *   node bin/migrate-to-lineages.mjs --db /tmp/x.db   # run against a specific DB
 *
 * Safe to run multiple times (idempotent).
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import os from 'os';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 ? args[dbIdx + 1] : path.join(os.homedir(), '.config', 'tlda', 'fleet.db');

if (dryRun) console.log(`[DRY RUN] Reading from ${DB_PATH} — no writes.\n`);
else console.log(`Running migration on ${DB_PATH}\n`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Ensure lineage tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS lineages (
    id TEXT PRIMARY KEY,
    friendly_name TEXT UNIQUE,
    labels TEXT,
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS lineage_phase_log (
    lineage_id TEXT,
    fleet_id TEXT,
    phase TEXT,
    entered_at INTEGER,
    exited_at INTEGER,
    PRIMARY KEY (lineage_id, fleet_id, entered_at)
  );
`);

// Ensure agents have lineage columns
const agentCols = db.prepare("PRAGMA table_info(agents)").all();
if (!agentCols.some(c => c.name === 'lineage_id')) {
  db.exec("ALTER TABLE agents ADD COLUMN lineage_id TEXT");
}
if (!agentCols.some(c => c.name === 'phase')) {
  db.exec("ALTER TABLE agents ADD COLUMN phase TEXT");
}

const now = Date.now();

// Group agents by friendly_name (skip fleet:XXXX names — those are auto-generated, not real names)
const allAgents = db.prepare('SELECT * FROM agents WHERE friendly_name IS NOT NULL').all();
const byName = new Map();
for (const a of allAgents) {
  if (a.friendly_name.startsWith('fleet:')) continue;
  if (!byName.has(a.friendly_name)) byName.set(a.friendly_name, []);
  byName.get(a.friendly_name).push(a);
}

const plan = [];
let lineagesCreated = 0;
let agentsAssigned = 0;
let skippedSiblings = 0;

for (const [name, group] of byName) {
  const existing = db.prepare('SELECT id FROM lineages WHERE friendly_name = ?').get(name);

  // Find the primary — most recently seen non-dead agent
  const sorted = group.filter(a => !a.dead).sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''));
  const primary = sorted[0];

  if (!primary) {
    // All dead — skip
    plan.push({ name, action: 'skip', reason: 'all agents dead', agents: group.map(a => a.id) });
    continue;
  }

  // Skip if primary already has a lineage
  if (primary.lineage_id) {
    plan.push({ name, action: 'skip', reason: 'primary already in lineage', primary: primary.id });
    continue;
  }

  const lineageId = existing?.id || ('lineage:' + crypto.randomUUID().slice(0, 8));
  const siblings = group.filter(a => a !== primary);

  plan.push({
    name,
    action: existing ? 'reuse-lineage' : 'create-lineage',
    lineageId,
    primary: { id: primary.id, last_seen: primary.last_seen, dead: !!primary.dead },
    siblings: siblings.map(a => ({ id: a.id, dead: !!a.dead, last_seen: a.last_seen })),
  });

  if (!existing) lineagesCreated++;
  agentsAssigned++;
  skippedSiblings += siblings.length;
}

// Print plan
console.log(`Plan: ${lineagesCreated} lineages to create, ${agentsAssigned} agents to assign as day, ${skippedSiblings} siblings left clean\n`);
for (const p of plan) {
  if (p.action === 'skip') {
    console.log(`  SKIP "${p.name}" — ${p.reason}`);
  } else {
    console.log(`  ${p.action.toUpperCase()} "${p.name}" → ${p.lineageId}`);
    console.log(`    day: ${p.primary.id} (last_seen: ${p.primary.last_seen})`);
    if (p.siblings.length > 0) {
      console.log(`    siblings left clean: ${p.siblings.map(s => `${s.id}${s.dead ? ' (dead)' : ''}`).join(', ')}`);
    }
  }
}

if (dryRun) {
  console.log('\n[DRY RUN] No changes written.');
  db.close();
  process.exit(0);
}

// Execute
console.log('\nExecuting...');
db.transaction(() => {
  for (const p of plan) {
    if (p.action === 'skip') continue;

    if (p.action === 'create-lineage') {
      db.prepare('INSERT INTO lineages (id, friendly_name, labels, created_at) VALUES (?, ?, ?, ?)')
        .run(p.lineageId, p.name, '[]', now);
    }

    db.prepare('UPDATE agents SET lineage_id = ?, phase = ? WHERE id = ?')
      .run(p.lineageId, 'day', p.primary.id);
    db.prepare('INSERT OR IGNORE INTO lineage_phase_log (lineage_id, fleet_id, phase, entered_at) VALUES (?, ?, ?, ?)')
      .run(p.lineageId, p.primary.id, 'day', now);
  }
})();

console.log(`\nDone:
  Lineages created: ${lineagesCreated}
  Agents assigned as day: ${agentsAssigned}
  Siblings left clean: ${skippedSiblings}
  Total agents with names: ${allAgents.length}
  Unique names: ${byName.size}`);

db.close();
