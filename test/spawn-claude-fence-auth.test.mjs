import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as claude from '../bin/lib/spawn/harness/claude.mjs'

test('Claude fence read roots include auth and tlda config contents', () => {
  const source = readFileSync(new URL('../bin/lib/spawn/fence.mjs', import.meta.url), 'utf8')
  assert.match(source, /'~\/\.claude\/\*\*'/)
  assert.match(source, /'~\/\.config\/tlda\/\*\*'/)
  assert.match(source, /'~\/Library\/Keychains\/\*\*'/)
  assert.match(source, /com\.apple\.securityd/)
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
