// Tests for the boot config installer.
//
// Reserved example values only: example.com and RFC-2606 names. No real origin,
// no real project name, nothing deployment-specific.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'

const INSTALLER = join(dirname(fileURLToPath(import.meta.url)), 'install-private-environment-url.mjs')

const DAEMON_WITH_SENTINEL = `environments:
  default: example
  values:
    example:
      database: https://example.com
      store: https://example.com
      licenseKey: ""
    source:
      database: __TLDA_PROMOTION_SOURCE_URL__
      store: __TLDA_PROMOTION_SOURCE_URL__
      licenseKey: ""
`

// Only allowlisted keys: server.yaml's top level is CLOSED, so a fixture with
// an invented key fails the loader for the wrong reason.
const SERVER_PLAIN = `uploadDir: /tmp/uploads\nbuildPriority: 10\n`

function run(env, { daemon = DAEMON_WITH_SENTINEL, server = SERVER_PLAIN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'installer-test-'))
  const daemonPath = join(dir, 'daemon.yaml')
  const serverPath = join(dir, 'server.yaml')
  writeFileSync(daemonPath, daemon)
  writeFileSync(serverPath, server)
  let error = null
  try {
    execFileSync(process.execPath, [INSTALLER, daemonPath, serverPath], {
      env: { ...process.env, TLDA_PROMOTION_SOURCE_URL: undefined, TLDA_PREVIEW_DELIVERY: undefined, ...env },
      stdio: 'pipe',
    })
  } catch (e) {
    error = `${e.stderr?.toString() || ''}${e.message}`
  }
  return { error, daemon: readFileSync(daemonPath, 'utf8'), server: readFileSync(serverPath, 'utf8') }
}

test('absent TLDA_PREVIEW_DELIVERY leaves server.yaml untouched', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com' })
  assert.equal(r.error, null)
  assert.equal(r.server, SERVER_PLAIN)
  assert.ok(!r.server.includes('previewDelivery'))
})

test('empty TLDA_PREVIEW_DELIVERY is treated as absent, not as an error', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com', TLDA_PREVIEW_DELIVERY: '' })
  assert.equal(r.error, null)
  assert.equal(r.server, SERVER_PLAIN)
})

test('a valid map is installed', () => {
  const r = run({
    TLDA_PROMOTION_SOURCE_URL: 'https://example.com',
    TLDA_PREVIEW_DELIVERY: '{"example-project":"example-destination"}',
  })
  assert.equal(r.error, null)
  assert.match(r.server, /^previewDelivery:$/m)
  assert.match(r.server, /^ {2}"example-project": "example-destination"$/m)
})

test('non-JSON is refused', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com', TLDA_PREVIEW_DELIVERY: 'not json' })
  assert.match(r.error, /must be JSON/)
  assert.equal(r.server, SERVER_PLAIN)
})

test('a JSON array is refused', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com', TLDA_PREVIEW_DELIVERY: '["example-project"]' })
  assert.match(r.error, /object mapping project name to environment/)
})

test('a non-string destination is refused', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com', TLDA_PREVIEW_DELIVERY: '{"example-project":3}' })
  assert.match(r.error, /must be a non-empty string/)
})

test('an empty destination is refused', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com', TLDA_PREVIEW_DELIVERY: '{"example-project":""}' })
  assert.match(r.error, /must be a non-empty string/)
})

for (const [label, declared] of [
  ['plain', 'previewDelivery:\n  other: example-destination\n'],
  ['quoted', '"previewDelivery":\n  other: example-destination\n'],
  ['spaced before colon', 'previewDelivery :\n  other: example-destination\n'],
  ['inline empty map', 'previewDelivery: {}\n'],
]) {
  test(`a server.yaml already declaring previewDelivery (${label}) is refused`, () => {
    const r = run(
      { TLDA_PROMOTION_SOURCE_URL: 'https://example.com', TLDA_PREVIEW_DELIVERY: '{"example-project":"example-destination"}' },
      { server: `uploadDir: /tmp/uploads\n${declared}` },
    )
    assert.match(r.error, /already declares previewDelivery/)
  })
}

test('an empty JSON object is treated as no mapping, not a null key', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com', TLDA_PREVIEW_DELIVERY: '{}' })
  assert.equal(r.error, null)
  assert.equal(r.server, SERVER_PLAIN)
  assert.ok(!('previewDelivery' in parseYaml(r.server)))
})

test('the installed map parses as a string-to-string object, checked with the parser', () => {
  const r = run({
    TLDA_PROMOTION_SOURCE_URL: 'https://example.com',
    TLDA_PREVIEW_DELIVERY: '{"example-project":"example-destination","second-example":"example-destination"}',
  })
  assert.equal(r.error, null)
  const parsed = parseYaml(r.server)
  assert.deepEqual(parsed.previewDelivery, {
    'example-project': 'example-destination',
    'second-example': 'example-destination',
  })
})

test('the existing sentinel behaviour is unchanged', () => {
  const r = run({ TLDA_PROMOTION_SOURCE_URL: 'https://example.com' })
  assert.equal(r.error, null)
  assert.ok(!r.daemon.includes('__TLDA_PROMOTION_SOURCE_URL__'))
  assert.equal(r.daemon.split('https://example.com').length - 1, 4)
})

test('a missing source URL still fails when the sentinel is present', () => {
  const r = run({})
  assert.match(r.error, /TLDA_PROMOTION_SOURCE_URL is required/)
})

test('a daemon.yaml without the sentinel is left alone and server.yaml is still installed', () => {
  const r = run(
    { TLDA_PREVIEW_DELIVERY: '{"example-project":"example-destination"}' },
    { daemon: `environments:\n  default: example\n  values:\n    example:\n      database: https://example.com\n      store: https://example.com\n      licenseKey: ""\n` },
  )
  assert.equal(r.error, null)
  assert.match(r.server, /^ {2}"example-project": "example-destination"$/m)
})

// The parser says the YAML is well formed; the loader says the SERVER accepts
// it. They are different questions: server.yaml has a CLOSED top-level
// allowlist, so a key can parse and still refuse to boot.
test('the installed file is accepted by the real server config loader', async () => {
  const r = run({
    TLDA_PROMOTION_SOURCE_URL: 'https://example.com',
    TLDA_PREVIEW_DELIVERY: '{"example-project":"example-destination"}',
  })
  assert.equal(r.error, null)

  const dir = mkdtempSync(join(tmpdir(), 'installer-loader-'))
  writeFileSync(join(dir, 'server.yaml'), r.server)
  const loaded = JSON.parse(execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `import { loadServerConfig } from '${join(process.cwd(), 'shared', 'config.mjs')}'
     process.stdout.write(JSON.stringify(loadServerConfig().previewDelivery ?? null))`,
  ], { env: { ...process.env, TLDA_CONFIG_DIR: dir }, encoding: 'utf8' }))

  assert.deepEqual(loaded, { 'example-project': 'example-destination' })
})
