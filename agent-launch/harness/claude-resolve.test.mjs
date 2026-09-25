import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import { resolveLiveSessionIdentity } from './claude.mjs'
import { claudeProjectsBaseForConfig } from '../resume.mjs'

// A claude mint under an isolated agent config (CLAUDE_CONFIG_DIR set from the
// project's agentConfigDir) writes its transcript under that config's
// projects/ dir, not under ~/.claude/projects. Session binding must resolve
// the transcript where the runtime actually wrote it: by exact session id,
// never by launch-window guess.

const SESSION = 'b6063ad2-07f1-4d4f-bd19-5bb44b63f074'
const CLAUDE_ARGS = 'claude --session-id b6063ad2-07f1-4d4f-bd19-5bb44b63f074 --model opus'

function stubExec({ panePids = '4242', ps = null } = {}) {
  return async (command) => {
    if (command === 'tmux') return { stdout: `${panePids}\n` }
    if (command === 'ps') return { stdout: ps ?? `  4242     1 ${CLAUDE_ARGS}\n` }
    throw new Error(`unexpected command ${command}`)
  }
}

function writeIsolatedTranscript(projectsBase) {
  const dir = path.join(projectsBase, '-Users-x-work-book')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION}.jsonl`)
  writeFileSync(file, [
    JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION }),
    JSON.stringify({ type: 'assistant', message: { model: 'opus', content: [{ type: 'text', text: 'hi' }] }, cwd: '/Users/x/work/book' }),
    '',
  ].join('\n'))
  return file
}

test('an isolated agent config resolves its projects base under that config', () => {
  assert.equal(
    claudeProjectsBaseForConfig({ agentConfigDir: '/Users/x/.tlda/configs/math' }),
    path.join('/Users/x/.tlda/configs/math', 'claude', 'projects'),
  )
})

test('a config without an agent config dir resolves the default projects base', () => {
  const expected = path.join(homedir(), '.claude', 'projects')
  assert.equal(claudeProjectsBaseForConfig({}), expected)
  assert.equal(claudeProjectsBaseForConfig(), expected)
  assert.equal(claudeProjectsBaseForConfig({ agentConfigDir: '   ' }), expected)
})

test('a known session id binds its exact transcript under an isolated base', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-isolated-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectsBase = path.join(root, 'agent-cfg', 'claude', 'projects')
  const file = writeIsolatedTranscript(projectsBase)
  const identity = await resolveLiveSessionIdentity({
    agent: { id: 'fleet:test', session_id: SESSION, cwd: '/Users/x/work/book', registered_at: new Date().toISOString() },
    tmuxSession: 'fleet-test',
    projectsBase,
    _deps: {
      execFile: stubExec(),
      resolveTranscript: () => { throw new Error('exact session file must not fall through to transcript search') },
    },
  })
  assert.equal(identity.sessionId, SESSION)
  assert.equal(identity.jsonlPath, file)
  assert.equal(identity.model, 'opus')
  assert.equal(identity.cwd, '/Users/x/work/book')
})

test('a known session id with no transcript file stays missing rather than guessed', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-isolated-miss-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const projectsBase = path.join(root, 'agent-cfg', 'claude', 'projects')
  mkdirSync(projectsBase, { recursive: true })
  let searched = null
  const identity = await resolveLiveSessionIdentity({
    agent: { id: 'fleet:test', session_id: SESSION, cwd: '/Users/x/work/book', registered_at: new Date().toISOString() },
    tmuxSession: 'fleet-test',
    projectsBase,
    _deps: {
      execFile: stubExec(),
      resolveTranscript: async options => { searched = options; return null },
    },
  })
  assert.equal(identity, null)
  assert.equal(searched?.kind, 'claude')
})

test('resolution without a known session id keeps the generic transcript search', async () => {
  let searched = null
  const identity = await resolveLiveSessionIdentity({
    agent: { id: 'fleet:test', cwd: '/Users/x/work/book', registered_at: new Date().toISOString() },
    tmuxSession: 'fleet-test',
    _deps: {
      execFile: stubExec(),
      resolveTranscript: async options => { searched = options; return null },
    },
  })
  assert.equal(identity, null)
  assert.equal(searched?.kind, 'claude')
  assert.ok(!('acceptTranscript' in (searched || {})), 'no session filter without a known session id')
})
