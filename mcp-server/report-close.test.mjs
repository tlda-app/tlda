import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.FLEET_ID = 'fleet:report-agent'
const configDir = mkdtempSync(join(tmpdir(), 'report-close-bindings-'))
process.env.TLDA_CONFIG_DIR = configDir
process.env.TLDA_ENV = 'report-close-test'
writeFileSync(join(configDir, 'daemon.yaml'), [
  'environments:',
  '  default: report-close-test',
  '  values:',
  '    report-close-test:',
  '      database: http://127.0.0.1:1',
  '      store: http://127.0.0.1:1',
  '      licenseKey: ""',
  '',
].join('\n'))

const { __setFleetTransportForTest, handleFleetTool } = await import('./fleet-tools.mjs')

test('report closes through the durable fleet operation without creating a source project', async () => {
  const calls = []
  __setFleetTransportForTest({
    ephemeral: async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'agent-status') return { ok: true }
      if (operation === 'task-by-id') {
        return { task: { id: 'task-1', agent: 'fleet:report-agent', description: 'Focused task' } }
      }
      throw new Error(`unexpected ephemeral operation ${operation}`)
    },
    durable: async (operation, payload) => {
      calls.push({ operation, payload })
      assert.equal(operation, 'report-close')
      return { task_description: 'Focused task', close_event_id: 'event-1' }
    },
  })

  const result = await handleFleetTool('report', {
    task_id: 'task-1',
    summary: 'Implemented and verified the focused change.',
    close: true,
  })

  assert.equal(result.isError, undefined)
  assert.deepEqual(
    calls.map(call => call.operation).filter(operation => operation !== 'agent-status'),
    ['task-by-id', 'report-close'],
  )
  assert.match(result.content[0].text, /Report accepted\. Closed task: Focused task\./)
  assert.doesNotMatch(result.content[0].text, /Report (?:pushed|share)/)
})
