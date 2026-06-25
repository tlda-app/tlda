#!/usr/bin/env node
// One-time name-history seed for the 2026-06-06 lineage sweep.
//
// The sweep renamed ~516 live agents via direct UPDATEs (no lineage_phase_log
// entries). For agents that already had phase-log history under their original
// name, the generic backfill in fleet-store recovers it. But ~106 agents got a
// brand-new name with NO phase-log trail, so their original name was lost: their
// OLD chat/threads would render with the new (coarse) name. This script splices
// the original name back in as the pre-sweep span:
//
//     <original>  [registered_at, SWEEP_TS)
//     <current>   [SWEEP_TS,      NULL)      ← clamps the over-early current span
//
// Idempotent: skips any agent whose history already contains the original name.
// Run AFTER the server has migrated the DB (name_history must exist). Defaults
// target the live DB; pass --db to point elsewhere (e.g. a test copy).
//
//   node bin/seed-name-history-from-sweep.mjs [--db PATH] [--snapshot PATH] [--apply]
//
// Without --apply it's a dry run (prints what it would change).

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };
const APPLY = args.includes('--apply');
const DB_PATH = getArg('--db', path.join(os.homedir(), '.config', 'tlda', 'fleet.db'));
const SNAPSHOT = getArg('--snapshot',
  path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scratch', 'name-provenance', 'sweep-snapshot-original.tsv'));
const SWEEP_TS = getArg('--sweep-ts', '2026-06-06T18:08:24.000Z');

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 30000'); // coexist with the running server's writer
const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='name_history'").get();
if (!hasTable) {
  console.error('name_history table does not exist yet — start the migrated server first.');
  process.exit(1);
}

const rows = fs.readFileSync(SNAPSHOT, 'utf8').split('\n').filter(Boolean).map(l => l.split('\t'));
const getAgent = db.prepare('SELECT friendly_name, dead, registered_at FROM agents WHERE id = ?');
const getHist = db.prepare('SELECT id, friendly_name, from_ts, to_ts FROM name_history WHERE fleet_id = ? ORDER BY from_ts ASC');
const insertSpan = db.prepare('INSERT INTO name_history (fleet_id, friendly_name, from_ts, to_ts) VALUES (?, ?, ?, ?)');
const clampSpan = db.prepare('UPDATE name_history SET from_ts = ? WHERE id = ?');

// The snapshot name is authoritative for the name held AT sweep time. The agent
// is reachable in two safe shapes: one open span (the current name) plus, at
// most, corrupt closed spans (lineage_phase_log has known backwards-timestamp
// rows where to_ts < from_ts — inert, nameAt never returns them). We splice the
// original in as [registered_at, SWEEP) and clamp the current span to start at
// SWEEP. If the agent has a VALID closed span before the sweep, the original's
// placement is ambiguous — skip it for manual review rather than risk overlap.
let planned = [], skipUnsafe = [], skippedCovered = 0, skippedUnchanged = 0, skippedDead = 0, skippedNoOpen = 0;
for (const [id, orig] of rows) {
  if (!id || !orig) continue;
  const a = getAgent.get(id);
  if (!a) continue;
  if (a.dead) { skippedDead++; continue; }
  if (a.friendly_name === orig) { skippedUnchanged++; continue; }
  const hist = getHist.all(id);
  if (hist.some(h => h.friendly_name === orig)) { skippedCovered++; continue; }
  const open = hist.filter(h => h.to_ts === null);
  const validClosed = hist.filter(h => h.to_ts !== null && h.to_ts > h.from_ts && h.to_ts <= SWEEP_TS);
  if (open.length !== 1) { skippedNoOpen++; continue; }       // nameless-now or odd shape
  if (validClosed.length > 0) { skipUnsafe.push(`${orig}→${a.friendly_name} (${id})`); continue; }
  const span = open[0];
  const from = (a.registered_at && a.registered_at < SWEEP_TS) ? a.registered_at
    : (span.from_ts < SWEEP_TS ? span.from_ts : SWEEP_TS);
  planned.push({ id, orig, current: a.friendly_name, spanId: span.id, from });
}

console.log(`snapshot rows: ${rows.length}`);
console.log(`skipped — unchanged:${skippedUnchanged} dead:${skippedDead} already-covered:${skippedCovered} no-open-span:${skippedNoOpen} ambiguous(valid-closed):${skipUnsafe.length}`);
if (skipUnsafe.length) { console.log('ambiguous (left for manual review):'); skipUnsafe.forEach(e => console.log('  ' + e)); }
console.log(`to seed: ${planned.length} agents`);
for (const p of planned.slice(0, 15)) console.log(`  ${p.orig} → ${p.current}  (${p.id})  ${p.from?.slice(0,10)} → ${SWEEP_TS.slice(0,10)}`);
if (planned.length > 15) console.log(`  … and ${planned.length - 15} more`);

if (!APPLY) { console.log('\nDRY RUN — re-run with --apply to write.'); process.exit(0); }

const tx = db.transaction(() => {
  for (const p of planned) {
    insertSpan.run(p.id, p.orig, p.from, SWEEP_TS);   // original pre-sweep span
    clampSpan.run(SWEEP_TS, p.spanId);                 // current name starts at sweep
  }
});
tx();
console.log(`\nAPPLIED: seeded ${planned.length} original-name spans.`);
