import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = join(__dirname, '..')

test('proposal tools are not advertised or handled by the MCP server', () => {
  const src = readFileSync(join(root, 'mcp-server', 'index.mjs'), 'utf8')

  assert.doesNotMatch(src, /name:\s*['"]read_file['"]/)
  assert.doesNotMatch(src, /name:\s*['"]propose_edit['"]/)
  assert.doesNotMatch(src, /name:\s*['"]apply_proposal['"]/)
  assert.doesNotMatch(src, /name:\s*['"]outline_open['"]/)
  assert.doesNotMatch(src, /name:\s*['"]outline_apply['"]/)
  assert.doesNotMatch(src, /name:\s*['"]chain_open['"]/)
  assert.doesNotMatch(src, /name:\s*['"]chain_apply['"]/)
  assert.doesNotMatch(src, /name:\s*['"]graph_draw['"]/)
  assert.doesNotMatch(src, /if\s*\(\s*name\s*===\s*['"]read_file['"]\s*\)/)
  assert.doesNotMatch(src, /if\s*\(\s*name\s*===\s*['"]propose_edit['"]\s*\)/)
  assert.doesNotMatch(src, /if\s*\(\s*name\s*===\s*['"]apply_proposal['"]\s*\)/)
  assert.doesNotMatch(src, /if\s*\(\s*name\s*===\s*['"]outline_open['"]\s*\)/)
  assert.doesNotMatch(src, /if\s*\(\s*name\s*===\s*['"]outline_apply['"]\s*\)/)
  assert.doesNotMatch(src, /name\s*===\s*['"]chain_open['"]/)
  assert.doesNotMatch(src, /name\s*===\s*['"]chain_apply['"]/)
  assert.doesNotMatch(src, /if\s*\(\s*name\s*===\s*['"]graph_draw['"]\s*\)/)
  assert.doesNotMatch(src, /const\s+_proposals\b/)
  assert.doesNotMatch(src, /createProposal\(/)
})

test('edit and graph endpoints are not exposed by the project API', () => {
  const src = readFileSync(join(root, 'server', 'routes', 'projects.mjs'), 'utf8')

  assert.doesNotMatch(src, /router\.get\(['"]\/:name\/outline-model/)
  assert.doesNotMatch(src, /router\.post\(['"]\/:name\/outline-apply/)
  assert.doesNotMatch(src, /router\.get\(['"]\/:name\/chain/)
  assert.doesNotMatch(src, /router\.post\(['"]\/:name\/chain-apply/)
  assert.doesNotMatch(src, /router\.post\(['"]\/:name\/graph/)
  assert.doesNotMatch(src, /parseEditedOutline/)
  assert.doesNotMatch(src, /emitModelMarkdown/)
  assert.doesNotMatch(src, /parseChainMarkdown/)
  assert.doesNotMatch(src, /materializeGraph/)
})
