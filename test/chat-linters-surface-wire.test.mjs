// Real MCP chat surface against a booted test server: the actual `chat` tool
// handler speaks the real WS transport to a temp server with the explicit
// outline contract on. The recipient is a dead agent, so accepted sends are
// stored with a not-delivered receipt and wake nobody — this never touches
// the live fleet.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const SENDER = 'fleet:lint-surface-sender'
const DEAD_RECIPIENT = 'fleet:lint-surface-dead-end'
const ENV_NAME = 'chat-linters-surface-test'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

const root = mkdtempSync(join(tmpdir(), 'tlda-chat-linters-surface-'))
const configDir = join(root, 'config')
mkdirSync(configDir, { recursive: true })
const port = await unusedPort()
writeFileSync(join(configDir, 'daemon.yaml'), [
  'environments:',
  `  default: ${ENV_NAME}`,
  '  values:',
  `    ${ENV_NAME}:`,
  `      database: http://127.0.0.1:${port}`,
  `      store: http://127.0.0.1:${port}`,
  '      licenseKey: ""',
  '',
].join('\n'))
writeFileSync(join(configDir, 'server.yaml'), [
  'chatLinters:',
  '  outlineFileBacked:',
  '    enabled: true',
  '  outlineDepth:',
  '    enabled: true',
  '',
].join('\n'))
const outlineFile = join(root, 'outline.md')
writeFileSync(outlineFile, [
  '# Surface notes', '',
  '## the-plan', '', '- one', '- two', '',
  '## nested-plan', '', '- one', '  - one-a', '- two', '',
].join('\n'))

const dbPath = join(root, 'fleet.sqlite')
// Identity, fleet URL, and config dir are read at module scope, so the env
// must be set before the first project import — including FleetStore, which
// would otherwise freeze the real config dir.
process.env.FLEET_ID = SENDER
process.env.TLDA_CONFIG_DIR = configDir
process.env.TLDA_ENV = ENV_NAME
const { FleetStore } = await import('../server/lib/fleet-store.mjs')
{
  const seed = new FleetStore(dbPath, { taskDoc: false })
  const stamp = '2026-09-28T06:00:00.000Z'
  await seed.upsertAgent({
    id: SENDER, friendly_name: 'lint-surface-sender', labels: [],
    registered_at: stamp, last_seen: stamp, dead: false, human: false,
  })
  await seed.upsertAgent({
    id: DEAD_RECIPIENT, friendly_name: 'lint-surface-dead-end', labels: [],
    registered_at: stamp, last_seen: stamp, dead: true, human: false,
  })
  seed.close()
}

// The child server below gets the same config dir via its own env.
const { handleFleetTool, initFleet, __closeFleetChannelForTest } = await import('../mcp-server/fleet-tools.mjs')

function toolText(result) {
  return result?.content?.map(part => part.text || '').join('\n') || ''
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() > deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('MCP chat enforces the explicit outline contract and nothing else', async () => {
  // Test-only boot shim, copied from activity-operation-idempotency-wire.
  const shimPath = join(root, 'setpriority-eacces-shim.cjs')
  writeFileSync(shimPath, `
const os = require('node:os')
const originalSetPriority = os.setPriority
os.setPriority = (...args) => {
  try {
    return originalSetPriority.apply(os, args)
  } catch (error) {
    if (error?.info?.code === 'EACCES' || /EACCES/.test(error?.message || '')) return
    throw error
  }
}
`)

  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port),
      PROJECTS_DIR: join(root, 'projects'), TLDA_FLEET_DB: dbPath,
      TLDA_CONFIG_DIR: configDir, TLDA_ENV: ENV_NAME, TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
      NODE_OPTIONS: [`--require=${shimPath}`, process.env.NODE_OPTIONS].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForServer(child)
    initFleet({ notification: async () => {} })

    // The outline marker travels through the real MCP input: marked inline is
    // refused, with a single period before the template's own.
    const refused = await handleFleetTool('chat', {
      message: '## the plan\n\n- one\n- two\n',
      outline: true,
      to: DEAD_RECIPIENT,
    })
    assert.equal(refused.isError, true, `expected refusal, got ${toolText(refused)}`)
    assert.match(toolText(refused), /NOT DELIVERED/)
    assert.match(toolText(refused), /outline-file-backed/)
    assert.match(toolText(refused), /in place\. Re-sending/)

    // A marked flat outline with a source file fails depth as a list.
    const refusedFlat = await handleFleetTool('chat', {
      file: outlineFile,
      selector: 'the-plan',
      outline: true,
      to: DEAD_RECIPIENT,
    })
    assert.equal(refusedFlat.isError, true, `expected refusal, got ${toolText(refusedFlat)}`)
    assert.match(toolText(refusedFlat), /outline-depth/)

    // A marked nested outline with a source file is accepted.
    const acceptedNested = await handleFleetTool('chat', {
      file: outlineFile,
      selector: 'nested-plan',
      outline: true,
      to: DEAD_RECIPIENT,
    })
    assert.equal(acceptedNested.isError || false, false, `expected acceptance, got ${toolText(acceptedNested)}`)

    // An ordinary long message is accepted: length gates nothing.
    const acceptedLong = await handleFleetTool('chat', {
      message: `surface status ${'x'.repeat(2000)}`,
      to: DEAD_RECIPIENT,
    })
    assert.equal(acceptedLong.isError || false, false, `expected long acceptance, got ${toolText(acceptedLong)}`)

    // An ordinary flat list is accepted: shape gates nothing.
    const acceptedList = await handleFleetTool('chat', {
      message: '- alpha\n- beta\n- gamma\n',
      to: DEAD_RECIPIENT,
    })
    assert.equal(acceptedList.isError || false, false, `expected list acceptance, got ${toolText(acceptedList)}`)
  } finally {
    // Close the MCP-side channel before killing the server: its reconnect
    // loop would otherwise keep this process alive forever after shutdown.
    __closeFleetChannelForTest()
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
