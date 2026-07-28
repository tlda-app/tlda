#!/usr/bin/env node
// The mirror goes to every connected daemon, not to whichever machine pushed
// last. Before this, `lastSourceMachineId` was overwritten on every push, so
// with two people editing only the most recent pusher ever received the built
// version and everyone else silently fell behind.
//
// This file previously asserted the single-daemon call shape. It had also been
// dead since the transport rename in e9993c9e — it injected `sendRpc` while the
// factory took `sendDaemonEphemeral`, so it threw before reaching an assertion
// and nobody noticed. It now tests the contract that actually matters.

import assert from 'assert/strict'
import { createShadowMirrorRpcHandler } from '../server/lib/shadow-mirror-rpc.mjs'

const sourceScope = ['main.tex', 'figures/plot.pdf']
const args = { name: 'balancing-act', hash: '0123456789abcdef0123456789abcdef01234567', bundleBase64: 'bundle-payload', sourceScope }

function handlerWith({ daemons, send, last = 'air:stable' }) {
  const calls = []
  const [lastMachine, lastEnv] = last ? last.split(':') : [null, null]
  const handler = createShadowMirrorRpcHandler({
    readProject: () => ({ lastSourceMachineId: lastMachine, lastSourceEnvName: lastEnv }),
    daemonAddressFor: (machineId, envName) => `${machineId}:${envName}`,
    listDaemonKeys: () => daemons,
    sendDaemonEphemeral: async (daemonKey, op, payload) => {
      calls.push({ daemonKey, op, payload })
      return send(daemonKey)
    },
  })
  return { handler, calls }
}

// Every connected daemon is offered the mirror.
{
  const { handler, calls } = handlerWith({
    daemons: ['mini:stable', 'air:stable'],
    send: () => ({ ok: true, sourceDir: '/src' }),
  })
  const result = await handler(args)
  assert.deepEqual(calls.map(c => c.daemonKey).sort(), ['air:stable', 'mini:stable'])
  assert.deepEqual(calls[0].payload, { project: 'balancing-act', hash: args.hash, bundleBase64: 'bundle-payload', sourceScope })
  assert.equal(calls[0].payload.sourceScope, sourceScope, 'sourceScope passes through by reference')
  assert.deepEqual(result.mirrored.sort(), ['air:stable', 'mini:stable'])
  assert.deepEqual(result.declined, [])
}

// A machine that does not hold the project declines for itself. That is not a
// failure — the mirror succeeded — but the decline stays visible.
{
  const { handler } = handlerWith({
    daemons: ['mini:stable', 'stranger:testing'],
    last: 'mini:stable',
    send: (key) => {
      if (key === 'stranger:testing') throw new Error('project not watched on this daemon')
      return { ok: true, sourceDir: '/src' }
    },
  })
  const result = await handler(args)
  assert.deepEqual(result.mirrored, ['mini:stable'])
  assert.deepEqual(result.declined, [{ key: 'stranger:testing', reason: 'project not watched on this daemon' }])
  assert.equal(result.machine_id, 'mini')
}

// One machine failing does not stop the others — the old code had a single
// recipient, so any failure was total.
{
  const { handler } = handlerWith({
    daemons: ['mini:stable', 'air:stable'],
    send: (key) => (key === 'air:stable' ? { ok: false, error: 'sourceDir is not a git repo' } : { ok: true }),
  })
  const result = await handler(args)
  assert.deepEqual(result.mirrored, ['mini:stable'])
  assert.deepEqual(result.declined, [{ key: 'air:stable', reason: 'sourceDir is not a git repo' }])
}

// Nobody took it: that is a real failure and it names every reason.
{
  const { handler } = handlerWith({
    daemons: ['mini:stable', 'air:stable'],
    send: () => { throw new Error('nope') },
  })
  await assert.rejects(() => handler(args), /no daemon accepted the mirror for balancing-act/)
}

// No daemons at all means nobody currently has the project open. That is a
// normal no-op, distinct from connected daemons all declining or failing.
{
  const handler = createShadowMirrorRpcHandler({
    readProject: () => ({}),
    daemonAddressFor: (machineId, envName) => `${machineId}:${envName}`,
    listDaemonKeys: () => [],
    sendDaemonEphemeral: async () => { throw new Error('should not send') },
  })
  const result = await handler(args)
  assert.deepEqual(result, {
    ok: true,
    machine_id: null,
    env_name: null,
    mirrored: [],
    declined: [],
  })
}

console.log('shadow mirror fan-out: ok')
