import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:test-agent'
const CONFIG_DIR_FIXTURE = mkdtempSync(join(tmpdir(), 'chat-queued-bindings-'))
process.env.TLDA_CONFIG_DIR = CONFIG_DIR_FIXTURE
process.env.TLDA_ENV = 'chat-queued-test'
writeFileSync(join(CONFIG_DIR_FIXTURE, 'daemon.yaml'), [
  'environments:',
  '  default: chat-queued-test',
  '  values:',
  '    chat-queued-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __resetAgentPreambleForTest, __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

function installTransportStub() {
  const durableCalls = []
  __setFleetTransportForTest({
    ephemeral: async operation => {
      if (operation === 'resolve-chat-recipients') return { recipients: ['fleet:skip'] }
      if (operation === 'store-agents-by-ids') return []
      throw new Error(`unexpected ephemeral operation ${operation}`)
    },
    durable: async (operation, payload) => {
      durableCalls.push({ operation, payload })
      if (operation === 'chat') return { ok: true, queued: true, operation_id: payload._tempId }
      throw new Error(`unexpected durable operation ${operation}`)
    },
  })
  return { durableCalls }
}

// Regression: the MCP server's `chat` durable send blocks on
// FLEET_DURABLE_SEND_DEADLINE_MS (15s) while the daemon is still working, and
// on timeout returns `{ok:true, queued:true}` -- a legitimate, ongoing send,
// not a failure. The queued branch of the chat() tool used to tell the caller
// only "Queued locally; no server ACK yet", with no instruction not to
// resend -- unlike the sibling exception-path branch a few lines down, which
// already used describeDurableOutcome() to say "Do not re-send." An agent
// seeing the weaker message had every reason to retry, and every retry mints
// a fresh _tempId (fleet-tools.mjs ~3155), which defeats every idempotency
// check on the server and lands as a genuine second (or third, or fourth)
// message with a near-identical timestamp -- exactly the duplicate-thread-row
// symptom reported 2026-08-16.
test('a queued chat() result tells the caller not to resend', async () => {
  __resetAgentPreambleForTest()
  const { durableCalls } = installTransportStub()

  const result = await handleFleetTool('chat', {
    to: 'fleet:skip',
    message: 'do not duplicate me',
  })

  assert.equal(durableCalls.length, 1)
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /Do not re-send/)
  assert.match(result.content[0].text, /operation_id/)
})
