import assert from 'node:assert/strict'
import test from 'node:test'
import { reloadHumanFleetClients } from './targeted-client-control.mjs'

function socket(humanId, readyState = 1) {
  return {
    _tldaHumanId: humanId,
    readyState,
    messages: [],
    send(message) { this.messages.push(JSON.parse(message)) },
  }
}

test('reloadHumanFleetClients sends only to open sockets for the selected human', () => {
  const selected = socket('fleet:skip')
  const selectedClosed = socket('fleet:skip', 3)
  const otherHuman = socket('fleet:dmitry')
  const agent = socket(undefined)

  const result = reloadHumanFleetClients(
    [selected, selectedClosed, otherHuman, agent],
    'fleet:skip',
    { reason: 'stale-app-shell' },
  )

  assert.deepEqual(result, { humanId: 'fleet:skip', matched: 2, sent: 1 })
  assert.equal(selected.messages.length, 1)
  assert.equal(selected.messages[0].type, 'reload')
  assert.equal(selected.messages[0].reason, 'stale-app-shell')
  assert.equal(otherHuman.messages.length, 0)
  assert.equal(agent.messages.length, 0)
})

test('reloadHumanFleetClients rejects non-human fleet targets', () => {
  assert.throws(
    () => reloadHumanFleetClients([], '2461d9cb'),
    /humanId must be a fleet: human identity/,
  )
})
