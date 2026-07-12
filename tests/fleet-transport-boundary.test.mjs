import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const productionRoots = ['bin', 'daemon', 'mcp-server', 'server', 'shared']
const directTransportModules = [
  'fleet-transport-outbox',
  'resilient-ws',
  'sqlite-transport-outbox',
  'ws-reconnect-buffer',
  'ws-request-policy',
]

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(mjs|js|ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

function rel(file) {
  return path.relative(repoRoot, file)
}

test('production fleet code imports transport internals only through shared/fleet-transport', () => {
  const offenders = []
  for (const root of productionRoots) {
    for (const file of walk(path.join(repoRoot, root))) {
      const relative = rel(file)
      if (relative === 'shared/fleet-transport.mjs') continue
      if (directTransportModules.some(mod => relative === `shared/${mod}.mjs`)) continue
      const source = fs.readFileSync(file, 'utf8')
      for (const mod of directTransportModules) {
        const importRe = new RegExp(`from ['"][^'"]*/?${mod}\\.mjs['"]`)
        if (importRe.test(source)) offenders.push(`${relative} imports ${mod}.mjs directly`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('MCP notify uses fleet WS transport instead of direct /api/items HTTP', () => {
  const mcpSource = fs.readFileSync(path.join(repoRoot, 'mcp-server/fleet-tools.mjs'), 'utf8')
  const notifyStart = mcpSource.indexOf("if (name === 'notify')")
  assert.notEqual(notifyStart, -1)
  const notifyEnd = mcpSource.indexOf("// ---- task_list ----", notifyStart)
  assert.notEqual(notifyEnd, -1)
  const notifyBlock = mcpSource.slice(notifyStart, notifyEnd)
  assert.match(notifyBlock, /sendWS\('notify'/)
  assert.equal(notifyBlock.includes('/api/items'), false)

  const serverSource = fs.readFileSync(path.join(repoRoot, 'server/unified-server.mjs'), 'utf8')
  assert.match(serverSource, /if \(type === 'notify'\)/)
})
