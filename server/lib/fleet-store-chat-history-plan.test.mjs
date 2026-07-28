import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CHAT_HISTORY_EVENT_TYPES, FleetStore } from './fleet-store.mjs';

function planDetails(store, stmt, args) {
  return store.db
    .prepare(`EXPLAIN QUERY PLAN ${stmt.source}`)
    .all(...args)
    .map(row => row.detail);
}

test('global subscription-history reads force the timestamp index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fleet-store-plan-'));
  const dbPath = join(dir, 'fleet.db');
  const store = new FleetStore(dbPath, { taskDoc: false });
  try {
    const typeArgs = CHAT_HISTORY_EVENT_TYPES;
    const latest = planDetails(store, store._queryEventsLatest, [...typeArgs, 151]);
    const latestDesc = planDetails(store, store._queryEventsLatestDesc, [...typeArgs, 151]);
    const before = planDetails(store, store._queryEventsBefore, ['2026-07-26T20:30:00.000Z', ...typeArgs, 151]);
    const beforeDesc = planDetails(store, store._queryEventsBeforeDesc, ['2026-07-26T20:30:00.000Z', ...typeArgs, 151]);

    for (const details of [latest, latestDesc, before, beforeDesc]) {
      assert.ok(
        details.some(detail => detail.includes('USING INDEX idx_events_ts')),
        `expected timestamp-index scan, got:\n${details.join('\n')}`,
      );
      assert.ok(
        !details.some(detail => detail.includes('idx_events_type_id')),
        `must not use type/id index for timestamp-ordered global history:\n${details.join('\n')}`,
      );
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
