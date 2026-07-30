import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { getFleetTools } from '../mcp-server/fleet-tools.mjs'

test('chat-like MCP tools expose file+selector instead of file+section', () => {
  const tools = new Map(getFleetTools().map(tool => [tool.name, tool]))
  for (const name of ['chat', 'delegate', 'report']) {
    const properties = tools.get(name)?.inputSchema?.properties || {}
    assert.ok(properties.file, `${name} exposes file`)
    assert.ok(properties.selector, `${name} exposes selector`)
    assert.equal(properties.section, undefined, `${name} does not expose section`)
  }
})

test('chat schema documents pure Markdown suggestions', () => {
  const chat = getFleetTools().find(tool => tool.name === 'chat')
  assert.match(chat.description, /- \*\*label\*\* .+ \*optional command\*/)
  assert.doesNotMatch(chat.description, /label \|/)
})

test('note MCP schema exposes file+selector body form', () => {
  const source = fs.readFileSync(new URL('../mcp-server/index.mjs', import.meta.url), 'utf8')
  const noteStart = source.indexOf("name: 'note'")
  assert.notEqual(noteStart, -1)
  const refStart = source.indexOf("name: 'ref'", noteStart)
  const noteSchema = source.slice(noteStart, refStart)
  assert.match(noteSchema, /selector:\s*\{\s*type:\s*'string'/)
  assert.match(noteSchema, /With `selector`, selects Markdown from this file/)
})
