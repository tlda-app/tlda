import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FleetStore } from '../server/lib/fleet-store.mjs';
import { evalExprDirectional, parseFilter } from '../shared/fleet-labels.mjs';

test('default subscription matches only the owner identity', () => {
  const ast = parseFilter('to:fleet:worker');
  assert.equal(evalExprDirectional(ast, {
    toLabels: ['fleet:worker', 'awake'],
    subscriberLabels: ['fleet:worker', 'reviewers'],
  }), true);
  assert.equal(evalExprDirectional(ast, {
    toLabels: ['reviewers', 'awake'],
    subscriberLabels: ['fleet:worker', 'reviewers'],
  }), false);
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

test('default subscription is persisted once as the owner address', () => {
  const { store, dbPath } = tempStore();
  try {
    store.upsertAgent({ id: 'fleet:worker', friendly_name: 'worker', labels: ['reviewers'] });
    const first = store.ensureDefaultSubscription('fleet:worker');
    const second = store.ensureDefaultSubscription('fleet:worker');
    assert.equal(first.subscription_id, second.subscription_id);
    assert.equal(first.owner, 'fleet:worker');
    assert.equal(first.query, 'to:fleet:worker');
    assert.equal(first.notification_policy, 'immediate');
    assert.equal(store.getSubscriptionsByOwner('fleet:worker').length, 1);
  } finally {
    cleanup(store, dbPath);
  }
});

test('default subscription does not wiretap unrelated awake recipients', async () => {
  const { store, dbPath } = tempStore();
  try {
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender' });
    store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient' });
    store.upsertAgent({ id: 'fleet:worker', friendly_name: 'worker' });
    store.ensureDefaultSubscription('fleet:worker');

    const event = await store.share({ type: 'chat', from: 'fleet:sender', to: 'fleet:recipient', text: 'unrelated' });

    assert.equal(event.metadata?.wiretap_cc, undefined);
    assert.deepEqual(store.getUnread('fleet:worker'), []);
  } finally {
    cleanup(store, dbPath);
  }
});

test('default subscription upgrades the legacy broad wiretap on login', () => {
  const { store, dbPath } = tempStore();
  try {
    store.upsertAgent({ id: 'fleet:worker', friendly_name: 'worker', labels: ['reviewers'] });
    const legacyTap = store.addWiretap('fleet:worker', 'to:my_labels', null);
    const legacy = store.addSubscription({ owner: 'fleet:worker', query: 'to:my_labels', notificationPolicy: 'immediate', createdBy: 'fleet:worker', adapter: 'wiretap', adapterId: legacyTap.id });

    const upgraded = store.ensureDefaultSubscription('fleet:worker');

    assert.equal(upgraded.subscription_id, legacy.subscription_id);
    assert.equal(upgraded.query, 'to:fleet:worker');
    assert.equal(store.getWiretapsByAgent('fleet:worker')[0].filter, 'to:fleet:worker');
  } finally {
    cleanup(store, dbPath);
  }
});

test('store startup upgrades existing legacy default subscriptions', async () => {
  const { store, dbPath } = tempStore();
  try {
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender' });
    store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient' });
    store.upsertAgent({ id: 'fleet:worker', friendly_name: 'worker', labels: ['reviewers'] });
    const legacyTap = store.addWiretap('fleet:worker', 'to:my_labels', null);
    store.addSubscription({ owner: 'fleet:worker', query: 'to:my_labels', notificationPolicy: 'immediate', createdBy: 'fleet:worker', adapter: 'wiretap', adapterId: legacyTap.id });
    store.close();

    const reopened = new FleetStore(dbPath);
    try {
      const [subscription] = reopened.getSubscriptionsByOwner('fleet:worker');
      assert.equal(subscription.query, 'to:fleet:worker');
      assert.equal(reopened.getWiretapsByAgent('fleet:worker')[0].filter, 'to:fleet:worker');

      const event = await reopened.share({ type: 'chat', from: 'fleet:sender', to: 'fleet:recipient', text: 'unrelated after startup' });

      assert.equal(event.metadata?.wiretap_cc, undefined);
      assert.deepEqual(reopened.getUnread('fleet:worker'), []);
    } finally {
      reopened.close();
    }
  } finally {
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.unlinkSync(file) } catch { /* best-effort cleanup */ }
    }
  }
});
