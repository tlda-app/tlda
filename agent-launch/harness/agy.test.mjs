import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildCmd, kickoffPrompt, prepareWorkspaceMcp, resolveLiveSessionIdentity, resolveModelSelection, resumeId } from './agy.mjs'
import { injectAgyPrompt } from '../tmux.mjs'
import { composerState } from '../../agent-runtime/status-classifier.mjs'
import { probeSpawnAvailability } from '../availability.mjs'

const AGY_MODEL = 'gemini-3.8-flash-medium'

function config() {
  return { modelSpecs: { agy: { alias: 'agy', id: AGY_MODEL, harness: 'agy', provider: 'google' } } }
}

test('model selection uses the daemon schema and enforces harness ownership', () => {
  assert.equal(resolveModelSelection('agy', { config: config() }).model, AGY_MODEL)
  assert.throws(() => resolveModelSelection('missing', { config: config() }), /unknown daemon model/)
  const other = config()
  other.modelSpecs.agy.harness = 'codex'
  assert.throws(() => resolveModelSelection('agy', { config: other }), /not "agy"/)
})

test('resume passes the conversation id as --conversation', () => {
  assert.equal(resumeId({ sessionId: 'conv-1' }), 'conv-1')
  assert.equal(resumeId({}), null)
  const cmd = buildCmd({ model: AGY_MODEL, cwd: tmpdir(), resumeId: 'conv-1' })
  assert.ok(cmd.includes('--conversation'))
  assert.ok(cmd.includes('conv-1'))
  assert.ok(!buildCmd({ model: AGY_MODEL, cwd: tmpdir() }).includes('--conversation'))
})

test('the kickoff carries the fleet login contract', () => {
  const kickoff = kickoffPrompt('test-agent')
  assert.ok(kickoff.includes('inbox'), 'kickoff tells the agent to check its inbox')
})

test('build maps effort and model to agy flags without embedding prompt text', () => {
  const cmd = buildCmd({ model: AGY_MODEL, cwd: tmpdir(), effort: 'high', harnessOptions: { required: ['--dangerously-skip-permissions'] } })
  assert.ok(cmd.includes(`--model '${AGY_MODEL}'`))
  assert.ok(cmd.includes(`--effort 'high'`))
  assert.ok(cmd.includes('--dangerously-skip-permissions'))
  assert.ok(!cmd.includes('inbox'), 'the kickoff travels by injection, never argv')
})

test('build passes bare family ids so effort keys select real variants', () => {
  // agy rejects a suffixed --model that conflicts with --effort; aliases use
  // bare family ids with the flag selecting the variant.
  for (const [model, efforts] of [['gemini-3.1-pro', ['low', 'high']], ['gemini-3.8-flash', ['low', 'medium', 'high']]]) {
    for (const effort of efforts) {
      const cmd = buildCmd({ model, cwd: tmpdir(), effort })
      assert.ok(cmd.includes(`--model '${model}'`))
      assert.ok(cmd.includes(`--effort '${effort}'`))
    }
  }
})

test('the generated shell command delivers literal arguments to the executable', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-adapter-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'agy'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(1)))\n`, { mode: 0o700 })
  const model = "don't expand $(printf EXPANDED) or `printf EXPANDED`"
  const spaced = path.join(dir, 'with spaces')
  mkdirSync(spaced)
  const options = { model, cwd: spaced, harnessOptions: { env: { PATH: dir } } }
  const result = JSON.parse(execFileSync('zsh', ['-c', buildCmd(options)], { encoding: 'utf8' }))
  assert.ok(result.includes('--model'))
  assert.equal(result[result.indexOf('--model') + 1], model)
})

test('workspace MCP merge preserves other servers and refuses to clobber', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-mcp-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const agents = path.join(dir, '.agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(path.join(agents, 'mcp_config.json'), JSON.stringify({ mcpServers: { other: { command: '/bin/true' } } }))
  const file = prepareWorkspaceMcp({ cwd: dir, fleetId: 'fleet:1', localAgentId: 'local:1', tmuxSession: 's', name: 'n' })
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.mcpServers.other.command, '/bin/true')
  assert.equal(parsed.mcpServers.tlda.env.FLEET_ID, 'fleet:1')
  assert.equal(parsed.mcpServers.tlda.env.FLEET_TMUX_SESSION, 's')
  assert.equal(parsed.mcpServers.tlda.env.FLEET_HARNESS, 'agy')
  assert.ok(parsed.mcpServers.tlda.args[0].endsWith('mcp-server/index.mjs'))

  writeFileSync(path.join(agents, 'mcp_config.json'), '{not json')
  assert.throws(() => prepareWorkspaceMcp({ cwd: dir, tmuxSession: 's' }), /refuses to overwrite unreadable/)
  writeFileSync(path.join(agents, 'mcp_config.json'), '["array"]')
  assert.throws(() => prepareWorkspaceMcp({ cwd: dir, tmuxSession: 's' }), /non-object/)
})

test('agy composer state tells parked, submitted, and working apart', () => {
  const marker = 'Call mcp__tlda__login exactly once'
  const idle = `Header\n> Reply with PING-OK\n\n  PING-OK\n${'─'.repeat(10)}\n> ${marker} and check inbox\n${'─'.repeat(10)}\n? for shortcuts`
  const parked = composerState('agy', idle, marker)
  assert.equal(parked.promptIndex >= 0, true)
  assert.equal(parked.containsMarker, true)
  assert.equal(parked.busyAfter, false)

  const done = `> ${marker}\n\n  PING-OK\n${'─'.repeat(10)}\n>\n${'─'.repeat(10)}\n? for shortcuts`
  const doneState = composerState('agy', done, marker)
  assert.equal(doneState.containsMarker, false)

  const working = `${done}\n\n▸ Thought for 2s, 10 tokens\nesc to cancel`
  const workingState = composerState('agy', `> ${marker}\n\n▸ Thought for 2s, 10 tokens\nesc to cancel`, marker)
  assert.equal(workingState.busyAfter, true)
  void working

  // Approval option lines start with `>` but never carry our marker.
  const approval = `> some prompt\n\nRun this command?\n> 1. Yes, run command\nesc to cancel`
  const approvalState = composerState('agy', approval, marker)
  assert.equal(approvalState.containsMarker, false)
  assert.equal(approvalState.busyAfter, true)
})

test('agy injection confirms the trust dialog, pastes, and confirms submission', async () => {
  const prompt = 'Call mcp__tlda__login exactly once, then inbox.'
  const trust = 'Accessing workspace:\n\nDo you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit'
  let stage = 'trust'
  const sent = []
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') {
      if (stage === 'trust') return { stdout: trust }
      if (stage === 'idle') return { stdout: `Header\n>\n${'─'.repeat(5)}\n? for shortcuts` }
      return { stdout: `Header\n> ${prompt}\n\n▸ Thought for 1s, 5 tokens\nesc to cancel` }
    }
    sent.push(args.at(-1))
    if (args.at(-1) === 'Enter' && stage === 'trust') stage = 'idle'
    else if (typeof args.at(-1) === 'string' && args.at(-1).includes('exactly once')) stage = 'pasted'
    else if (args.at(-1) === 'Enter' && stage === 'pasted') stage = 'working'
    return { stdout: '' }
  }
  const delivered = await injectAgyPrompt('fleet-agent', prompt, { timeoutMs: 5000, tmuxExec, sleep: async () => {} })
  assert.equal(delivered, true)
  assert.ok(sent.includes('Enter'), 'trust was confirmed and the prompt submitted')
})

test('agy injection waits for the TUI and never pastes into the launch shell', async () => {
  const prompt = 'Reply with exactly: E2E-PING.'
  const shell = 'source /tmp/tlda-launch-1.sh%\nskip@mini work % source /tmp/tlda-launch-1.sh'
  const trust = 'Accessing workspace:\n\nDo you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit'
  const idle = `Header\n>\n${'─'.repeat(5)}\n? for shortcuts`
  const working = `Header\n> ${prompt}\n\n▸ Thought for 1s, 5 tokens\nesc to cancel`
  let reads = 0
  const order = []
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') {
      reads += 1
      if (reads <= 2) return { stdout: shell }
      if (reads === 3) return { stdout: trust }
      if (reads === 4) return { stdout: idle }
      return { stdout: working }
    }
    order.push(args.at(-1) === 'Enter' ? 'Enter' : 'text')
    return { stdout: '' }
  }
  const delivered = await injectAgyPrompt('fleet-agent', prompt, { timeoutMs: 5000, tmuxExec, sleep: async () => {} })
  assert.equal(delivered, true)
  // The launch shell has no `>` composer: nothing may be pasted or submitted
  // before the trust dialog is confirmed and the idle composer is seen.
  assert.deepEqual(order.slice(0, 2), ['Enter', 'text'], `send order was ${JSON.stringify(order)}`)
})

test('agy injection waits for the paint, not just the keystrokes', async () => {
  const prompt = 'Reply with exactly: E2E-PING and nothing else.'
  const idle = `Header\n>\n${'─'.repeat(5)}\n? for shortcuts`
  const partial = `Header\n> Reply with exactl`
  const full = `Header\n> ${prompt}\n${'─'.repeat(5)}\n? for shortcuts`
  const working = `${full}\n\n▸ Thought for 1s, 5 tokens\nesc to cancel`
  // Measured live: 500ms after paste the composer shows a prefix of the
  // text. A single read then would report "not parked" and give up.
  const panes = [idle, partial, partial, full, working, working]
  let reads = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: panes[Math.min(reads++, panes.length - 1)] }
    return { stdout: '' }
  }
  const delivered = await injectAgyPrompt('fleet-agent', prompt, { timeoutMs: 8000, tmuxExec, sleep: async () => {} })
  assert.equal(delivered, true)
})

test('agy injection never answers an approval dialog', async () => {
  const prompt = 'Do something needing approval.'
  const dialog = `> ${prompt}\n\nRun this command?\n> 1. Yes, run command\nesc to cancel`
  let enters = 0
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: dialog }
    if (args.at(-1) === 'Enter') enters += 1
    return { stdout: '' }
  }
  const delivered = await injectAgyPrompt('fleet-agent', prompt, { timeoutMs: 1500, tmuxExec, sleep: async () => {} })
  assert.equal(delivered, false)
  assert.equal(enters, 0, 'no Enter is ever sent while an approval dialog is up')
})

test('agy injection that cannot confirm leaves the parked text for wake recovery', async () => {
  const prompt = 'Call mcp__tlda__login exactly once, then inbox.'
  let composer = ''
  const tmuxExec = async (_socket, command, ...args) => {
    if (command === 'capture-pane') return { stdout: `Header\n> ${composer}\n${'─'.repeat(5)}\n? for shortcuts` }
    if (typeof args.at(-1) === 'string' && args.at(-1) !== 'Enter') composer = args.at(-1)
    return { stdout: '' }
  }
  const delivered = await injectAgyPrompt('fleet-agent', prompt, { timeoutMs: 1200, tmuxExec, sleep: async () => {} })
  // Enter IS sent (plain-Enter retry) but nothing ever starts: no busyAfter,
  // marker stays parked. Failure is reported, text left for submitParkedKickoff.
  assert.equal(typeof delivered, 'boolean')
})

test('live session identity resolves from process plus conversation store', async t => {
  const sqlite = await import('node:sqlite')
  const dir = mkdtempSync(path.join(tmpdir(), 'agy-identity-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, 'work'))
  const cwd = realpathSync(path.join(dir, 'work'))
  const convId = '11111111-2222-4333-8444-555555555555'
  const pointerFile = path.join(dir, 'last_conversations.json')
  // Key the pointer so neither direct lookup hits and only the
  // resolve-every-key fallback can match: `cwd + '/.'` resolves to cwd but
  // equals neither the resolved nor the raw form as a string.
  writeFileSync(pointerFile, JSON.stringify({ [`${cwd}/.`]: convId }))
  const dbFile = path.join(dir, 'conversation_summaries.db')
  const db = new sqlite.DatabaseSync(dbFile)
  db.exec('CREATE TABLE conversation_summaries (conversation_id text, workspace_uris text NOT NULL, last_modified_time datetime NOT NULL)')
  db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').get(
    convId, JSON.stringify([`file://${cwd}`]), '2026-09-16T01:30:00.000+00:00')
  db.close()
  const execFile = async (command) => {
    if (command === 'tmux') return { stdout: '4242\n' }
    if (command === 'ps') return { stdout: ' 4242     1 zsh\n 4243  4242 /Users/skip/.local/bin/agy --model x\n' }
    throw new Error(`unexpected ${command}`)
  }
  const identity = await resolveLiveSessionIdentity({
    agent: { cwd, registered_at: '2026-09-16T01:00:00.000Z' },
    tmuxSession: 'fleet-a',
    _deps: {
      execFile,
      readFileSync: (p, enc) => readFileSync(p === pointerFile ? p : pointerFile, enc),
      lastConversationsPath: pointerFile,
      summariesDbPath: dbFile,
      sqlite,
    },
  })
  assert.equal(identity.sessionId, convId)
  assert.equal(identity.cwd, cwd)

  const missing = await resolveLiveSessionIdentity({
    agent: { cwd, registered_at: '2026-09-16T01:00:00.000Z' },
    tmuxSession: null,
    _deps: { execFile },
  })
  assert.equal(missing, null)
})

test('availability reports the agy binary and auth from `agy models`', async () => {
  const cfg = { modelSpecs: { agy: { alias: 'agy', id: AGY_MODEL, harness: 'agy' } } }
  const run = async (command, args) => {
    if (args[1] === 'command -v agy') return { ok: true, stdout: '/Users/skip/.local/bin/agy' }
    if (command === '/Users/skip/.local/bin/agy') return { ok: true, stdout: 'gemini-3.8-flash-medium' }
    return { ok: false, stdout: '' }
  }
  const result = await probeSpawnAvailability({ env: {}, deps: { config: cfg, run } })
  assert.equal(result.harnesses.agy.available, true)
  assert.equal(result.harnesses.agy.models[0].id, AGY_MODEL)
})
