import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as claude from '../bin/lib/spawn/harness/claude.mjs'

test('Claude fence read roots include tlda config but not credential stores', () => {
  const source = readFileSync(new URL('../bin/lib/spawn/fence.mjs', import.meta.url), 'utf8')
  assert.match(source, /'~\/\.claude\/\*\*'/)
  assert.match(source, /'~\/\.config\/tlda\/\*\*'/)
  assert.doesNotMatch(source, /'~\/Library\/Keychains\/\*\*'/)
  assert.doesNotMatch(source, /com\.apple\.securityd/)
})

test('Claude launch does not point Node at the denied tlda pem path', () => {
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8[1m]',
    name: 'chief',
    api: 'https://example.test',
    config: {
      defaultConfig: 'default',
      configs: {
        default: { database: 'https://example.test', store: 'https://example.test', licenseKey: '' },
      },
    },
  })
  assert.match(cmd, /NODE_TLS_REJECT_UNAUTHORIZED=0/)
  assert.doesNotMatch(cmd, /NODE_EXTRA_CA_CERTS='\/Users\/skip\/\.config\/tlda\/localhost\+2\.pem'/)
})

test('Claude restored launches always enable tlda channel notifications', () => {
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8[1m]',
    name: 'release-train',
    resumeId: 'd49dd726-7b15-40ae-8d3c-7f77ce997b3b',
    includePrompt: false,
    config: {},
  })
  assert.match(cmd, /claude --dangerously-load-development-channels server:tlda --resume 'd49dd726-7b15-40ae-8d3c-7f77ce997b3b'/)
})

test('Claude launch uses static fleet OAuth token file without logging the token value', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tlda-claude-auth-'))
  const tokenDir = path.join(home, '.claude')
  const tokenPath = path.join(tokenDir, '.fleet-oauth-token')
  mkdirSync(tokenDir, { recursive: true })
  writeFileSync(tokenPath, 'secret-token-value\n')
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8[1m]',
    name: 'release-train',
    includePrompt: false,
    config: {},
    env: { HOME: home },
  })
  assert.match(cmd, /CLAUDE_CODE_OAUTH_TOKEN=\$\(cat '/)
  assert.match(cmd, new RegExp(tokenPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(cmd, /secret-token-value/)
})

test('Claude channel flag is a recommended default that config may deliberately replace', () => {
  const cmd = claude.buildCmd({
    fleetId: 'fleet:test',
    tmuxSession: 'fleet-test',
    model: 'claude-opus-4-8[1m]',
    name: 'release-train',
    resumeId: 'd49dd726-7b15-40ae-8d3c-7f77ce997b3b',
    includePrompt: false,
    config: {
      harnessOptions: {
        claude: {
          '*': { required: [], preferences: ['--permission-mode plan'], controls: true },
        },
      },
    },
  })
  assert.doesNotMatch(cmd, /--dangerously-load-development-channels server:tlda/)
  assert.match(cmd, /--permission-mode plan/)
})
