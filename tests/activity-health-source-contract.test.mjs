import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

const daemonIngestor = fs.readFileSync(new URL('../daemon/jsonl-ingestor.mjs', import.meta.url), 'utf8')
const server = fs.readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')

function indexOfOrThrow(source, needle) {
  const index = source.indexOf(needle)
  assert.notEqual(index, -1, `missing source marker: ${needle}`)
  return index
}

test('watcher update emits OK only after ingester update succeeds', () => {
  const updateIndex = indexOfOrThrow(daemonIngestor, "_jsonlIngester?.send?.({\n              type: 'update'")
  const okIndex = indexOfOrThrow(daemonIngestor, "boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_ATTACHED,\n              reason: `${harness.kind} watcher updated`")
  const failIndex = indexOfOrThrow(daemonIngestor, 'boundary: ACTIVITY_HEALTH_BOUNDARIES.WATCH_UPDATE_FAILED')

  assert.ok(okIndex > updateIndex, 'watcher update OK must be emitted after _jsonlIngester.send')
  assert.ok(failIndex > okIndex, 'watcher update catch must emit explicit unhealthy state')
})

test('new watcher stat and creation failures emit explicit unhealthy boundaries', () => {
  assert.match(daemonIngestor, /catch \(e\) \{\n\s+sendActivityHealth\(agent, \{\n\s+state: ACTIVITY_HEALTH_UNAVAILABLE,\n\s+boundary: ACTIVITY_HEALTH_BOUNDARIES\.WATCH_STAT_FAILED/)
  assert.match(daemonIngestor, /catch \(e\) \{\n\s+\/\/ One failed watcher should not prevent other agents from being watched\.\n\s+log\.error\(`watcher creation failed.*\n\s+sendActivityHealth\(agent, \{\n\s+state: ACTIVITY_HEALTH_UNAVAILABLE,\n\s+boundary: ACTIVITY_HEALTH_BOUNDARIES\.WATCH_CREATE_FAILED/)
})

test('runtime tail failure retirements carry explicit unhealthy boundaries', () => {
  assert.match(daemonIngestor, /healthKind: 'start-failed'/)
  assert.match(daemonIngestor, /healthKind: 'error'/)
  assert.match(daemonIngestor, /healthKind: 'ack-failed'/)
  assert.match(daemonIngestor, /healthKind: 'delivery-failed'/)
  assert.match(daemonIngestor, /sendActivityHealth\(pw\.primaryAgentId, jsonlRuntimeFailureActivityHealth\(pw, options\.healthKind, options\.healthDetail\)\)/)
})

test('daemon transport disconnect and reconnect update activity health', () => {
  assert.match(server, /updateDaemonActivityTransportHealth\(ws\._daemonKey, \{\n\s+state: ACTIVITY_HEALTH_UNAVAILABLE,\n\s+boundary: ACTIVITY_HEALTH_BOUNDARIES\.TRANSPORT_DISCONNECTED,\n\s+reason: 'daemon websocket closed'/)
  assert.match(server, /updateDaemonActivityTransportHealth\(ws\._daemonKey, \{\n\s+state: ACTIVITY_HEALTH_UNAVAILABLE,\n\s+boundary: ACTIVITY_HEALTH_BOUNDARIES\.TRANSPORT_DISCONNECTED,\n\s+reason: 'daemon websocket error'/)
  assert.match(server, /await updateDaemonActivityTransportHealth\(daemonKey, \{\n\s+state: ACTIVITY_HEALTH_OK,\n\s+boundary: ACTIVITY_HEALTH_BOUNDARIES\.TRANSPORT_CONNECTED,\n\s+reason: 'daemon websocket connected'/)
})

test('incident reservation is persisted before awaiting fleet incident chat', () => {
  const reserveIndex = indexOfOrThrow(server, 'pending: true,')
  const persistIndex = indexOfOrThrow(server, 'let updatedAgent = fleetStore.updateAgentActivityHealthIncidents?.(agent.id, incidents) || fresh')
  const awaitIndex = indexOfOrThrow(server, 'const event = await reportFleetIncident(payload)')

  assert.ok(reserveIndex < persistIndex, 'pending reservation must be assembled before persistence')
  assert.ok(persistIndex < awaitIndex, 'incident reservation must persist before awaiting chat write')
})
