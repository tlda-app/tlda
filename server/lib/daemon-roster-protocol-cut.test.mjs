import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '..', '..')
const serverSource = readFileSync(join(root, 'server', 'unified-server.mjs'), 'utf8')
const daemonSource = readFileSync(join(root, 'bin', 'fleet-daemon.mjs'), 'utf8')
const deliverySource = readFileSync(join(root, 'daemon', 'delivery-policy.mjs'), 'utf8')
const storeMethodsSource = readFileSync(join(root, 'server', 'lib', 'fleet-store-methods.mjs'), 'utf8')

test('daemon roster/status protocols have no sender, handler, delivery policy, or store method', () => {
  assert.doesNotMatch(daemonSource, /sendMsg\(\{\s*type: 'agent-status'/)
  assert.doesNotMatch(daemonSource, /sendMsg\(\{\s*type: 'daemon-roster'/)
  assert.doesNotMatch(serverSource, /if \(type === 'agent-status'\)/)
  assert.doesNotMatch(serverSource, /if \(type === 'daemon-roster'\)/)
  assert.doesNotMatch(deliverySource, /'agent-status'/)
  assert.doesNotMatch(deliverySource, /'daemon-roster'/)
  assert.doesNotMatch(storeMethodsSource, /admitDaemonAgentStatusIdentities/)
  assert.doesNotMatch(storeMethodsSource, /replaceAgentDaemonRoutes/)
  assert.doesNotMatch(storeMethodsSource, /refreshAgentLiveness/)
  assert.doesNotMatch(storeMethodsSource, /updateAgentStatus/)
})
