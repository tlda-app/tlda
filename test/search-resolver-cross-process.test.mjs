// Agent resolution must give the same answer in a second process.
//
// Search does not run in the process that writes the store. `fleet-search`
// forks `server/lib/fleet-search-process.mjs`, which opens the same database
// readonly and holds its own `FleetStore` — so anything resolution reads out of
// per-process memory is empty there and silently resolves to nothing.
//
// That is not hypothetical. A resolver for status pseudo-labels was written
// against `_hydrateAgent`, which reads `runtime_status` from
// `_runtimeStatusByAgent` — a map the MAIN process fills via
// `refreshAgentLiveness`. It passed every single-process test and resolved
// `awake` to nothing in the child, which is where search actually runs. Green
// and inert: the worst shape a test can miss, because the tests say the wire is
// connected.
//
// So this file asserts the property rather than any one resolver: what the
// writer resolves, a fresh readonly store over the same file resolves too. It
// is cheap, and it fails for the whole class.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FleetStore } from '../server/lib/fleet-store.mjs';

function withWriterAndReader(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-resolver-xproc-'));
  const dbPath = join(dir, 'fleet.db');
  const writer = new FleetStore(dbPath, { taskDoc: false });
  try {
    writer.upsertAgent({ id: 'fleet:one', friendly_name: 'alpha', labels: ['project:tlda', 'on-call'] });
    writer.upsertAgent({ id: 'fleet:two', friendly_name: 'beta', labels: ['project:tlda'] });
    // Opened after the writes, the way the forked child opens a store that is
    // already populated.
    const reader = new FleetStore(dbPath, { readonly: true, taskDoc: false });
    try {
      return fn(writer, reader);
    } finally {
      reader.close();
    }
  } finally {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a readonly second process resolves names, ids and labels identically', () => withWriterAndReader((writer, reader) => {
  for (const fragment of ['alpha', 'beta', 'fleet:one', 'project:tlda', 'on-call', 'nosuchagent']) {
    const fromWriter = [...writer.resolveAgentSelector({ fragment })].sort();
    const fromReader = [...reader.resolveAgentSelector({ fragment })].sort();
    assert.deepEqual(fromReader, fromWriter, `"${fragment}" resolved differently in a second process`);
  }
}));

test('the comparison is not vacuous: these fragments really do resolve to agents', () => withWriterAndReader((writer, reader) => {
  // Without this, a resolver returning [] for everything would satisfy the test
  // above — both sides equal, both sides empty, wire severed. That is precisely
  // the failure this file exists to catch, so it has to be ruled out explicitly.
  assert.deepEqual(reader.resolveAgentSelector({ fragment: 'alpha' }), ['fleet:one']);
  assert.deepEqual(
    [...reader.resolveAgentSelector({ fragment: 'project:tlda' })].sort(),
    ['fleet:one', 'fleet:two'],
  );
  assert.deepEqual(reader.resolveAgentSelector({ fragment: 'on-call' }), ['fleet:one']);
  assert.deepEqual(reader.resolveAgentSelector({ fragment: 'nosuchagent' }), []);
}));

test('a write made after the reader opened is visible to it', () => withWriterAndReader((writer, reader) => {
  // The child outlives many writes. A resolver answering from state captured at
  // open would pass both tests above and still go stale in production.
  writer.upsertAgent({ id: 'fleet:three', friendly_name: 'gamma', labels: ['project:tlda'] });
  assert.deepEqual(reader.resolveAgentSelector({ fragment: 'gamma' }), ['fleet:three']);
  assert.deepEqual(
    [...reader.resolveAgentSelector({ fragment: 'project:tlda' })].sort(),
    ['fleet:one', 'fleet:three', 'fleet:two'],
  );
}));
