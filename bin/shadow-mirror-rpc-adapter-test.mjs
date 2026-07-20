#!/usr/bin/env node

import assert from 'assert/strict'
import { createShadowMirrorRpcHandler } from '../server/lib/shadow-mirror-rpc.mjs'

async function main() {
  const calls = []
  const sourceScope = ['main.tex', 'figures/plot.pdf', 'old-name.tex']
  const handler = createShadowMirrorRpcHandler({
    readProject: (name) => {
      assert.equal(name, 'balancing-act')
      return { lastSourceMachineId: 'fly-author-machine', lastSourceEnvName: 'default' }
    },
    daemonAddressFor: (machineId, envName) => `${machineId}/${envName}`,
    sendRpc: async (daemonKey, op, payload) => {
      calls.push({ daemonKey, op, payload })
      return { ok: true, preservation: { committed: true } }
    },
  })

  const result = await handler({
    name: 'balancing-act',
    hash: '0123456789abcdef0123456789abcdef01234567',
    bundleBase64: 'bundle-payload',
    sourceScope,
  })

  assert.deepEqual(calls, [{
    daemonKey: 'fly-author-machine/default',
    op: 'mirror-shadow-ref',
    payload: {
      project: 'balancing-act',
      hash: '0123456789abcdef0123456789abcdef01234567',
      bundleBase64: 'bundle-payload',
      sourceScope,
    },
  }])
  assert.equal(calls[0].payload.sourceScope, sourceScope)
  assert.deepEqual(result, {
    ok: true,
    preservation: { committed: true },
    machine_id: 'fly-author-machine',
    env_name: 'default',
  })

  await assert.rejects(
    () => createShadowMirrorRpcHandler({
      readProject: () => ({ lastSourceMachineId: 'fly-author-machine' }),
      daemonAddressFor: () => 'unused',
      sendRpc: async () => {
        throw new Error('sendRpc should not run without an env')
      },
    })({ name: 'missing-env', hash: 'h', bundleBase64: 'b', sourceScope: ['main.tex'] }),
    /no source daemon recorded for missing-env/,
  )

  console.log('shadow mirror rpc adapter regression passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
