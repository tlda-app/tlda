import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const liveCallers = [
  'cli/tlda.mjs',
  'cli/lib/dev-worktree.mjs',
  'bin/live-editor-acceptance.mjs',
  'src/panels/TocTab.tsx',
  'src/shapes/FleetPillShape.tsx',
  'src/shapes/FleetSourceEditorShape.tsx',
]

test('every live non-Git source caller enters through the server-side room checkout', () => {
  for (const file of liveCallers) {
    const source = readFileSync(file, 'utf8')
    assert.match(source, /\/source-room\/files/, `${file} must use the room Git boundary`)
    assert.doesNotMatch(source, /\/source-(?:snapshot|authority|entries|bundle|blob)/, `${file} retains an old source authority call`)
  }
})

test('deleted snapshot and bundle carriers have no server or executable test callers', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  await assert.rejects(
    run('rg', ['-n', 'source-(?:snapshot|bundle)', 'server', 'bin']),
    error => error?.code === 1,
  )
})
