// Singleton labels: a label at most one living agent may hold.
//
// Skip, 2026-09-01 03:55–03:59 EDT: "labels should be, at creation time, marked
// singleton or not… perhaps we don't want multiple on-call agents… so if you
// try to apply on-call and someone has it, you get an error telling you that
// like, if you really mean it, strip it and then apply it" — and "we should
// like make on-call singleton as a migration or wahtever".
//
// Each test here is a property of the running system, not a check that some
// implementation is present: repetition is allowed for an ordinary label and
// refused for a singleton one, the refusal names the holder, the remedy he
// specified works, and no write path around label() can bypass it.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-singleton-labels-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    return run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function agent(store, id, friendlyName, labels = []) {
  store.upsertAgent({
    id,
    friendly_name: friendlyName,
    labels,
    registered_at: '2026-09-01T00:00:00.000Z',
  })
}

test('an ordinary label repeats across agents; a singleton label does not', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  agent(store, 'fleet:b', 'beta')

  store.mutateAgentLabels('fleet:a', 'add', 'reviewers')
  store.mutateAgentLabels('fleet:b', 'add', 'reviewers')
  assert.deepEqual(store.getAgent('fleet:b').labels, ['reviewers'])
  assert.equal(store.getLabelDefinition('reviewers').singleton, 0)

  store.mutateAgentLabels('fleet:a', 'add', 'siren', { singleton: true })
  assert.equal(store.getLabelDefinition('siren').singleton, 1)
  assert.throws(
    () => store.mutateAgentLabels('fleet:b', 'add', 'siren'),
    /singleton label and agent fleet:a holds it.*remove it from fleet:a first/s,
  )
  assert.deepEqual(store.getAgent('fleet:b').labels, ['reviewers'])
}))

test('the remedy Skip specified works: strip it there, then apply it here', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  agent(store, 'fleet:b', 'beta')
  store.mutateAgentLabels('fleet:a', 'add', 'siren', { singleton: true })

  store.mutateAgentLabels('fleet:a', 'remove', 'siren')
  assert.deepEqual(store.mutateAgentLabels('fleet:b', 'add', 'siren').labels, ['siren'])

  // The definition survives having no holder, so the rule still applies.
  assert.equal(store.getLabelDefinition('siren').singleton, 1)
  assert.throws(() => store.mutateAgentLabels('fleet:a', 'add', 'siren'), /singleton label/)
}))

test('re-applying a singleton label you already hold is not a collision', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  store.mutateAgentLabels('fleet:a', 'add', 'siren', { singleton: true })
  store.mutateAgentLabels('fleet:a', 'add', 'siren', { singleton: true })
  store.mutateAgentLabels('fleet:a', 'replace', ['siren'])
  assert.deepEqual(store.getAgent('fleet:a').labels, ['siren'])
}))

test('singleton-ness is set at creation and is not changed by applying the label', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  agent(store, 'fleet:b', 'beta')
  store.mutateAgentLabels('fleet:a', 'add', 'reviewers')

  assert.throws(
    () => store.mutateAgentLabels('fleet:b', 'add', 'reviewers', { singleton: true }),
    /already exists as a non-singleton label/,
  )
  assert.equal(store.getLabelDefinition('reviewers').singleton, 0)
  // The rejected declaration left nothing behind: b still has no labels.
  assert.deepEqual(store.getAgent('fleet:b').labels, [])

  // And the explicit migration verb is the route that does change it.
  assert.equal(store.setLabelSingleton('reviewers', true, { actorId: 'fleet:a' }).singleton, 1)
  assert.throws(() => store.mutateAgentLabels('fleet:b', 'add', 'reviewers'), /singleton label/)
}))

test('a failed application leaves no definition behind', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  agent(store, 'fleet:b', 'beta')
  // "beta" is a living friendly name, so this add is rejected by the name half
  // of the same gate — after the definitions for this call were written.
  assert.throws(() => store.mutateAgentLabels('fleet:a', 'add', ['fresh-tag', 'beta']), /friendly name of a living agent/)
  assert.equal(store.getLabelDefinition('fresh-tag'), null)
}))

test('on-call is a singleton label on a fresh store, and existing holders are left alone', () => withStore(store => {
  assert.equal(store.getLabelDefinition('on-call').singleton, 1)

  // Two holders as they would exist from before the property: written straight
  // to the column, the way rows predating this feature already are.
  agent(store, 'fleet:a', 'alpha')
  agent(store, 'fleet:b', 'beta')
  store.db.prepare("UPDATE agents SET labels = '[\"on-call\"]' WHERE id IN ('fleet:a','fleet:b')").run()
  store._bustAgentsCache()
  assert.deepEqual(store.livingHoldersOfLabel('on-call'), ['fleet:a', 'fleet:b'])

  // Nothing stripped them; the next application is what is refused.
  agent(store, 'fleet:c', 'gamma')
  assert.throws(() => store.mutateAgentLabels('fleet:c', 'add', 'on-call'), /singleton label/)
}))

test('a dead holder frees a singleton label, the same as a friendly name', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  agent(store, 'fleet:b', 'beta')
  store.mutateAgentLabels('fleet:a', 'add', 'siren', { singleton: true })
  assert.throws(() => store.mutateAgentLabels('fleet:b', 'add', 'siren'), /singleton label/)

  store.markDead('fleet:a')
  assert.deepEqual(store.mutateAgentLabels('fleet:b', 'add', 'siren').labels, ['siren'])
}))

test('names and singleton labels stay one namespace in both directions', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  agent(store, 'fleet:b', 'beta')
  store.mutateAgentLabels('fleet:a', 'add', 'siren', { singleton: true })

  // A friendly name may not equal any live agent's label; a singleton one is no
  // exception, and it is refused as the name collision it is.
  assert.equal(
    store.checkNameAvailable(['siren'], { excludeId: 'fleet:b', asFriendlyName: true })[0].kind,
    'label',
  )
  // A singleton label may not equal a living friendly name either.
  assert.throws(() => store.mutateAgentLabels('fleet:a', 'add', 'beta', { singleton: true }), /friendly name of a living agent/)
}))

test('register and login cannot smuggle in a singleton label someone else holds', () => withStore(store => {
  agent(store, 'fleet:a', 'alpha')
  store.mutateAgentLabels('fleet:a', 'add', 'siren', { singleton: true })

  // upsertAgent is the register/login path. It strips rather than throwing —
  // the shape it already had for a name collision — but it does not let the
  // label through.
  agent(store, 'fleet:b', 'beta', ['siren', 'reviewers'])
  assert.deepEqual(store.getAgent('fleet:b').labels, ['reviewers'])
  assert.deepEqual(store.livingHoldersOfLabel('siren'), ['fleet:a'])

  // And a label first seen at registration is defined, non-singleton.
  assert.equal(store.getLabelDefinition('reviewers').singleton, 0)
}))
