import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { probeSpawnCapabilities } from '../bin/lib/spawn/capabilities.mjs'

function runner({ commands = {}, env = {} } = {}) {
  return async (command, args = []) => {
    if (command === 'zsh' && args[0] === '-lc') {
      const script = args[1]
      const commandMatch = script.match(/^command -v (.+)$/)
      if (commandMatch) {
        const target = commandMatch[1]
        const found = commands[target]
        return found ? { ok: true, stdout: `${found}\n`, stderr: '' } : { ok: false, stdout: '', stderr: '' }
      }
      const envMatch = script.match(/print -r -- "\$(\w+)"/)
      if (envMatch) return { ok: true, stdout: env[envMatch[1]] ? `${env[envMatch[1]]}\n` : '\n', stderr: '' }
    }
    if (command === 'security') return commands.security ? { ok: true, stdout: 'token\n', stderr: '' } : { ok: false, stdout: '', stderr: 'not found' }
    if (command.endsWith('/cursor-agent') && args[0] === '--version') return { ok: true, stdout: 'cursor-agent 1.0.0\n', stderr: '' }
    return { ok: false, stdout: '', stderr: `unexpected ${command} ${args.join(' ')}` }
  }
}

test('capability probe reports installed/authed harnesses and verified goose models', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-cap-'))
  const authFile = path.join(tmp, 'auth.json')
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }))
  const report = await probeSpawnCapabilities({
    now: new Date('2026-06-28T00:00:00Z'),
    deps: {
      codexAuthFile: authFile,
      run: runner({
        commands: {
          claude: '/opt/homebrew/bin/claude',
          codex: '/opt/homebrew/bin/codex',
          goose: '/opt/homebrew/bin/goose',
          [path.join(os.homedir(), '.local/bin/cursor-agent')]: path.join(os.homedir(), '.local/bin/cursor-agent'),
          security: true,
        },
        env: { OPENROUTER_API_KEY: 'sk-test' },
      }),
    },
  })
  assert.equal(report.schema, 1)
  assert.equal(report.generated_at, '2026-06-28T00:00:00.000Z')
  assert.equal(report.harnesses.claude.available, true)
  assert.equal(report.harnesses.codex.available, true)
  assert.equal(report.harnesses.goose.available, true)
  assert.equal(report.harnesses.cursor.available, true)
  assert.equal(report.default.kind, 'claude')
  assert.equal(report.default.alias, 'opus')
  assert.ok(report.harnesses.goose.models.some((m) => m.id === 'deepseek/deepseek-v4-pro' && m.available && m.verified))
  assert.ok(report.harnesses.goose.models.some((m) => m.id === 'google/gemini-3.5-flash' && !m.available && !m.verified))
})

test('capability probe is explicit about missing auth and binaries', async () => {
  const report = await probeSpawnCapabilities({
    deps: {
      codexAuthFile: path.join(os.tmpdir(), 'missing-codex-auth.json'),
      run: runner({ commands: { codex: '/opt/homebrew/bin/codex' } }),
    },
  })
  assert.equal(report.harnesses.claude.available, false)
  assert.equal(report.harnesses.claude.binary.reason, 'binary-missing')
  assert.equal(report.harnesses.codex.available, false)
  assert.equal(report.harnesses.codex.authenticated.reason, 'not-authenticated')
  assert.equal(report.harnesses.goose.available, false)
  assert.equal(report.harnesses.cursor.available, false)
  assert.ok(report.harnesses.goose.models.some((m) => m.id === 'cursor-agent/default' && m.verified && !m.available))
  assert.equal(report.default, null)
})
