import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetStore } from '../server/lib/fleet-store.mjs';
import { evalExprDirectional, parseFilter } from '../shared/fleet-labels.mjs';

test('default subscription matches the owner identity and current labels lazily', () => {
  const ast = parseFilter('to:my_labels');
  assert.equal(evalExprDirectional(ast, {
    toLabels: ['fleet:worker'],
    subscriberLabels: ['fleet:worker', 'reviewers'],
  }), true);
  assert.equal(evalExprDirectional(ast, {
    toLabels: ['reviewers'],
    subscriberLabels: ['fleet:worker', 'reviewers'],
  }), true);
  assert.equal(evalExprDirectional(ast, {
    toLabels: ['other-agent'],
    subscriberLabels: ['fleet:worker', 'reviewers'],
  }), false);
});

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `fleet-subscriptions-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
  }
  return { store: new FleetStore(dbPath), dbPath };
}

function cleanup(store, dbPath) {
  store.close();
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
  }
}

test('default subscription is persisted once as to:my_labels', () => {
  const { store, dbPath } = tempStore();
  try {
    store.upsertAgent({ id: 'fleet:worker', friendly_name: 'worker', labels: ['reviewers'], status: 'awake' });
    const first = store.ensureDefaultSubscription('fleet:worker');
    const second = store.ensureDefaultSubscription('fleet:worker');
    assert.equal(first.subscription_id, second.subscription_id);
    assert.equal(first.owner, 'fleet:worker');
    assert.equal(first.query, 'to:my_labels');
    assert.equal(first.notification_policy, 'immediate');
    assert.equal(store.getSubscriptionsByOwner('fleet:worker').length, 1);
  } finally {
    cleanup(store, dbPath);
  }
});
