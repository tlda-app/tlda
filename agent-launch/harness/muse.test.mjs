import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { HARNESS } from '../../shared/harness.ts'
import { buildArgs, buildCmd, capabilities, resolveModelSelection, resumeId } from './muse.mjs'

const model = 'meta/muse-spark-1.3-contributor'
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

test('native resume retains the bare session identity without inventing exec flags', () => {
  const id = '01900000-0000-7000-8000-000000000001'
  assert.equal(resumeId({ sessionId: id }), id)
  assert.equal(resumeId({}), null)
  assert.deepEqual(buildArgs({ ...base, resumeId: id }).slice(-2), ['resume', id])
  assert.throws(() => buildArgs({ ...base, resumeId: id, headless: true }), /no verified resume flag/)
  assert.throws(() => buildArgs({ ...base, freshSessionId: id }), /not the verified TUI flags/)
  assert.deepEqual(buildArgs({ ...base, headless: true, freshSessionId: id }).slice(-2), ['--session-id', id])
})

test('launch resolves credentials at runtime and refuses fleet startup while MCP is unverified', () => {
  const cmd = buildCmd({ ...base, prompt: "don't run `id` or $(id)", env: { OPENROUTER_API_KEY: 'secret-test-value' } })
  assert.ok(cmd.includes('OPENROUTER_API_KEY'))
  assert.ok(!cmd.includes('secret-test-value'))
  assert.ok(!cmd.includes('--yolo'))
  assert.ok(!cmd.includes('--no-foreign-personal-context'))
  assert.equal(capabilities.fleetReady, false)
  assert.throws(() => buildCmd({ ...base, fleetId: 'fleet:example' }), /not successfully invoked TLDA MCP/)
  assert.throws(() => buildCmd({ ...base, harnessOptions: { env: { META_API_KEY: 'secret-test-value' } } }), /process environment/)
})

test('model selection uses the existing daemon model schema and enforces harness ownership', () => {
  const config = { modelSpecs: { contributor: { alias: 'contributor', id: model, harness: 'muse', provider: 'openrouter' } } }
  assert.equal(resolveModelSelection('contributor', { config }).model, model)
  assert.equal(resolveModelSelection('contributor', { config }).provider, 'openrouter')
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
    encoding: 'utf8', env: { ...process.env, OPENROUTER_API_KEY: 'test-credential' },
  }))
  assert.deepEqual(result.args, buildArgs(options))
  assert.equal(result.credentialPresent, true)
})
