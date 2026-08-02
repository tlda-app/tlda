import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { FleetStoreClient } from '../server/lib/fleet-store-client.mjs'
import { FLEET_STORE_METHODS } from '../server/lib/fleet-store-methods.mjs'

// A method missing from FLEET_STORE_METHODS is not proxied to the worker, so on
// the main thread it is simply `undefined`. Calling it throws "is not a
// function" from the call site, which is nowhere near the manifest that caused
// it — and only on the branch that calls it, so the gap ships.
//
// That is how `labelCollisionMessage` got out: it is only reached when a mint
// requests a label that collides with a living name, so the mint failed with a
// TypeError instead of the message naming which of the three reasons it was.
const SERVER_FILES = ['server/unified-server.mjs']

const CALL = /\bfleetStore\??\.\s*([A-Za-z_$][\w$]*)\s*\(/g

function repoFile(relative) {
  return fileURLToPath(new URL(`../${relative}`, import.meta.url))
}

test('every fleetStore method the server calls actually crosses the worker boundary', () => {
  const proxied = new Set(FLEET_STORE_METHODS)
  // Anything FleetStoreClient implements itself is reachable without being
  // proxied — that is what the "Deliberately NOT here" section of the manifest
  // is for.
  const ownedByClient = new Set(Object.getOwnPropertyNames(FleetStoreClient.prototype))

  const unreachable = []
  for (const relative of SERVER_FILES) {
    readFileSync(repoFile(relative), 'utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(CALL)) {
        const method = match[1]
        if (proxied.has(method) || ownedByClient.has(method)) continue
        unreachable.push(`${relative}:${index + 1} calls fleetStore.${method}()`)
      }
    })
  }

  assert.deepEqual(
    unreachable,
    [],
    `These calls resolve to undefined on the main thread. Add the method to\n` +
    `FLEET_STORE_METHODS in server/lib/fleet-store-methods.mjs, or implement it\n` +
    `on FleetStoreClient and record why under "Deliberately NOT here":\n  ` +
    unreachable.join('\n  '),
  )
})

test('the manifest lists nothing the client implements itself', () => {
  // The constructor throws on this, but only when a store is actually opened.
  const ownedByClient = new Set(Object.getOwnPropertyNames(FleetStoreClient.prototype))
  const shadowed = FLEET_STORE_METHODS.filter(method => ownedByClient.has(method))
  assert.deepEqual(shadowed, [])
})
