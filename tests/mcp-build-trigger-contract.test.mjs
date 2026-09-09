import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the MCP build tool submits rebuild intent through the owning daemon', async () => {
  const source = await readFile(new URL('../mcp-server/index.mjs', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf("if (name === 'build')"), source.indexOf("if (name === 'lookup_theorem')"))
  assert.match(handler, /callLocalDaemonRpc\('project-rebuild', \{ project: doc \}, \{ socketPath: TLDA_DAEMON_SOCKET \}\)/)
  assert.match(handler, /\*\*Build triggered\.\*\*/)
})
