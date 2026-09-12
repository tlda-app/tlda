import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HARNESS } from '../../shared/harness.ts'
import { buildArgs, buildCmd, capabilities, prepareFleetConfig, resolveModelSelection, resumeId } from './muse.mjs'
import { runtimeStateFromProcessList } from '../tmux.mjs'
import { probeSpawnAvailability } from '../availability.mjs'
import { readDaemonConfig, withDaemonModelAliases } from '../permission-ledger.mjs'

const model = 'muse-spark-1.3-contributor'
const base = { model, cwd: '/workspace/project' }

test('the skill gate points to the observed native user-scope catalog', () => {
  assert.equal(HARNESS.muse.skillsDir, '~/.agents/skills')
  assert.equal(HARNESS.muse.educationGate, true)
  assert.equal(HARNESS.muse.requiresClaudeSession, false)
})

test('native headless invocation preserves workspace, prompt, and configured permissions', () => {
  const prompt = 'Read a file with spaces; do not interpret $(this) in a shell.'
  assert.deepEqual(buildArgs({ ...base, headless: true, prompt, harnessOptions: { required: ['--trust-workspace'], preferences: ['--no-foreign-personal-context'] } }), [
    'exec', '--json', '--model', model, '--workspace', base.cwd,
    '--trust-workspace', '--no-foreign-personal-context', prompt,
  ])
  assert.deepEqual(buildArgs(base), ['--model', model, '--workspace', base.cwd])
})

test('the configured fleet TUI launch uses unattended mode without exec-only flags', () => {
  const config = withDaemonModelAliases({}, readDaemonConfig(new URL('../../config/daemon.yaml', import.meta.url).pathname))
  const { spec } = resolveModelSelection('muse', { config })
  assert.deepEqual(spec.harnessOptions.required, ['--yolo'])
  assert.deepEqual(buildArgs({ ...base, model: spec.id, harnessOptions: spec.harnessOptions }), [
    '--model', model, '--workspace', base.cwd, '--yolo',
  ])
})

test('native resume retains the bare session identity without inventing exec flags', () => {
  const id = '01900000-0000-7000-8000-000000000001'
  assert.equal(resumeId({ sessionId: id }), id)
  assert.equal(resumeId({}), null)
  assert.deepEqual(buildArgs({ ...base, resumeId: id }).slice(-2), ['resume', id])
  assert.throws(() => buildArgs({ ...base, resumeId: id, headless: true }), /no verified resume flag/)
  assert.throws(() => buildArgs({ ...base, freshSessionId: id }), /not the verified TUI flags/)
  assert.deepEqual(buildArgs({ ...base, headless: true, freshSessionId: id }).slice(-2), ['--session-id', id])
})

test('launch uses native account auth and enforces the current fleet gate', () => {
  const cmd = buildCmd({ ...base, prompt: "don't run `id` or $(id)", env: { OPENROUTER_API_KEY: 'secret-test-value' } })
  assert.ok(!cmd.includes('OPENROUTER_API_KEY'))
  assert.ok(cmd.includes('unset META_API_KEY'))
  assert.ok(!cmd.includes('secret-test-value'))
  assert.ok(!cmd.includes('--yolo'))
  assert.ok(!cmd.includes('--no-foreign-personal-context'))
  if (!capabilities.fleetReady) {
    assert.throws(() => buildCmd({ ...base, fleetId: 'fleet:example' }), /not yet verified/)
  }
  assert.throws(() => buildCmd({ ...base, harnessOptions: { env: { META_API_KEY: 'secret-test-value' } } }), /muse login/)
})

test('model selection uses the existing daemon model schema and enforces harness ownership', () => {
  const config = { modelSpecs: { contributor: { alias: 'contributor', id: model, harness: 'muse', provider: 'meta' } } }
  assert.equal(resolveModelSelection('contributor', { config }).model, model)
  assert.equal(resolveModelSelection('contributor', { config }).provider, 'meta')
  assert.throws(() => resolveModelSelection('missing', { config }), /unknown daemon model/)
  config.modelSpecs.contributor.harness = 'goose'
  assert.throws(() => resolveModelSelection('contributor', { config }), /not "muse"/)
})

test('the generated shell command delivers literal arguments to the executable', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'muse-adapter-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'muse'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),credentialPresent:Boolean(process.env.META_API_KEY)}))\n`, { mode: 0o700 })
  const prompt = "don't expand $(printf EXPANDED) or `printf EXPANDED`"
  const options = { ...base, cwd: '/workspace/with spaces', headless: true, prompt, harnessOptions: { env: { PATH: dir } } }
  const result = JSON.parse(execFileSync('zsh', ['-c', buildCmd(options)], {
    encoding: 'utf8', env: { ...process.env, META_API_KEY: 'stale-provider-key', OPENROUTER_API_KEY: 'test-credential' },
  }))
  assert.deepEqual(result.args, buildArgs(options))
  assert.equal(result.credentialPresent, false)
})

test('fleet MCP configuration isolates identity and references native auth without copying it', t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'muse-fleet-config-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = path.join(dir, 'source', 'muse')
  mkdirSync(source, { recursive: true })
  writeFileSync(path.join(source, 'auth.json'), '{"test":"not-a-real-credential"}')
  writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ schema_version: 1, endpoint_transport: { base_url: 'https://example.com' }, model_catalog: [], tui: { theme: 'dark' } }))
  const env = { XDG_CONFIG_HOME: path.dirname(source), TMPDIR: dir, TLDA_ENV: 'testing', TLDA_MACHINE_ID: 'test-machine' }
  const a = prepareFleetConfig({ localAgentId: 'local:first', name: 'first', tmuxSession: 'first', env })
  const b = prepareFleetConfig({ localAgentId: 'local:second', name: 'second', tmuxSession: 'second', env })
  assert.notEqual(a.XDG_CONFIG_HOME, b.XDG_CONFIG_HOME)
  const settingsText = readFileSync(path.join(a.XDG_CONFIG_HOME, 'muse', 'settings.json'), 'utf8')
  const settings = JSON.parse(settingsText)
  assert.equal(settings.mcpServers.tlda.env.FLEET_MINT_ID, 'local:first')
  assert.equal(settings.mcpServers.tlda.env.FLEET_HARNESS, 'muse')
  assert.equal(settings.mcpServers.tlda.env.FLEET_DAEMON_KEY, 'test-machine:testing')
  assert.equal(settings.mcpServers.tlda.framing, 'line_delimited_json')
  assert.equal(settings.endpoint_transport, undefined)
  assert.equal(settings.model_catalog, undefined)
  assert.equal(settings.tui.theme, 'dark')
  assert.ok(!settingsText.includes('not-a-real-credential'))
  assert.equal(readlinkSync(path.join(a.XDG_CONFIG_HOME, 'muse', 'auth.json')), path.join(source, 'auth.json'))
  if (capabilities.fleetReady) {
    const cmd = buildCmd({ ...base, localAgentId: 'local:first', name: 'first', tmuxSession: 'first', env })
    assert.ok(cmd.includes('mcp__tlda__login'))
    assert.ok(cmd.includes('mcp__tlda__inbox'))
    assert.ok(cmd.includes('local:first'))
    assert.ok(!cmd.includes('not-a-real-credential'))
  }
})

test('runtime detection recognizes Muse binary and its MCP child', () => {
  const result = runtimeStateFromProcessList(['10'], '10 1 zsh\n11 10 /usr/local/bin/muse-bin-1.1.1-R2514.1\n12 11 node /workspace/mcp-server/index.mjs')
  assert.equal(result.runtime, true)
  assert.equal(result.mcp, true)
  assert.equal(runtimeStateFromProcessList(['10'], '10 1 zsh').runtime, false)
})

test('availability checks the model-configured native account root', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'muse-availability-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(path.join(dir, 'muse'))
  const config = { modelSpecs: { muse: { alias: 'muse', id: model, harness: 'muse', harnessOptions: { env: { XDG_CONFIG_HOME: dir } } } } }
  const run = async (_command, args) => args[1] === 'command -v muse' ? { ok: true, stdout: '/example/muse' } : { ok: false, stdout: '' }
  const options = { env: {}, deps: { config, run } }
  assert.equal((await probeSpawnAvailability(options)).harnesses.muse.available, false)
  writeFileSync(path.join(dir, 'muse', 'auth.json'), JSON.stringify({ providers: { meta: { storage: 'test-storage' } } }))
  const result = await probeSpawnAvailability(options)
  assert.equal(result.harnesses.muse.available, true)
  assert.equal(result.harnesses.muse.models[0].id, model)
})
