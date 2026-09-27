import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pathPatternMatcher, buildSeatbeltProfile } from '../bin/fence-seatbelt.mjs'

// CA exception: the secrets denies are unrooted, so `**/*.pem` matches the
// system CA bundles (/etc/ssl/cert.pem and the Homebrew equivalents). The
// emitted profile must re-allow reads of the CA directories after the denies
// (SBPL last match wins). Added 2026-09-27 when the bare emitter fix took
// three agents off the air by denying every bundle read.

const here = path.dirname(fileURLToPath(import.meta.url))
const seatbelt = path.join(here, '..', 'bin', 'fence-seatbelt.mjs')

const CA_DIRS = [
  '/etc/ssl',
  '/private/etc/ssl',
  '/opt/homebrew/etc/ca-certificates',
  '/opt/homebrew/etc/openssl@3',
  '/opt/homebrew/etc/gnutls',
]

const CA_BUNDLES = [
  '/etc/ssl/cert.pem',
  '/private/etc/ssl/cert.pem',
  '/opt/homebrew/etc/ca-certificates/cert.pem',
  '/opt/homebrew/etc/openssl@3/cert.pem',
  '/opt/homebrew/etc/gnutls/cert.pem',
]

function regexOf(pattern) {
  const matcher = pathPatternMatcher(pattern)
  const m = matcher.match(/^\(regex #"(.*)"\)$/)
  assert.ok(m, `expected a regex matcher for ${pattern}, got: ${matcher}`)
  return m[1]
}

function testSettings() {
  return {
    filesystem: {
      allowWrite: ['/'],
      denyRead: ['**/.env', '**/*.pem'],
      denyWrite: ['**/*.pem'],
    },
  }
}

test('enforcing **/*.pem deny matches CA bundle paths (why the exception exists)', () => {
  const body = regexOf('**/*.pem')
  assert.ok(!body.includes('(?:'), `deny emits void PCRE group: ${body}`)
  const re = new RegExp(body)
  for (const bundle of CA_BUNDLES) {
    assert.ok(re.test(bundle), `enforcing deny must match ${bundle}`)
  }
})

test('emitted profile re-allows CA directory reads after every deny', () => {
  const profile = buildSeatbeltProfile(testSettings())
  const allowIdx = profile.indexOf('(allow file-read*')
  assert.ok(allowIdx >= 0, `profile carries no CA re-allow:\n${profile}`)
  for (const dir of CA_DIRS) {
    assert.ok(profile.includes(`(subpath "${dir}")`), `re-allow misses ${dir}:\n${profile}`)
  }
  const lastDeny = Math.max(profile.lastIndexOf('(deny file-read*'), profile.lastIndexOf('(deny file-write*'))
  assert.ok(lastDeny >= 0 && allowIdx > lastDeny, `re-allow must sort after every deny:\n${profile}`)
})

test('CA re-allow is reads-only', () => {
  const profile = buildSeatbeltProfile(testSettings())
  const line = profile.split('\n').find((l) => l.startsWith('(allow file-read*'))
  assert.ok(line, `profile carries no CA re-allow:\n${profile}`)
  assert.ok(!line.includes('file-write'), `re-allow must not permit writes: ${line}`)
})

test('secrets denies still present alongside the exception', () => {
  const profile = buildSeatbeltProfile(testSettings())
  assert.ok(profile.includes('deny file-read*'), `profile lost the read deny:\n${profile}`)
  const re = new RegExp(regexOf('**/*.pem'))
  assert.ok(re.test('/tmp/workspace/key.pem'), 'workspace secret must still match the deny')
})

function sandboxUsable() {
  // Same preflight as the sibling secrets test: sandbox-exec cannot apply
  // profiles from some agent contexts, so skip instead of lying.
  try {
    const out = execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/bin/echo', 'ok'], { encoding: 'utf8', timeout: 10000 })
    return out.trim() === 'ok'
  } catch {
    return false
  }
}

test('live: .env refused while CA bundle readable under one profile', {
  skip: process.platform !== 'darwin' || !sandboxUsable(),
}, () => {
  const bundle = '/etc/ssl/cert.pem'
  assert.ok(fs.existsSync(bundle), `live CA control missing on this box: ${bundle}`)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-ca-except-')))
  try {
    const sub = path.join(root, 'sub')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, '.env'), 'CANARY-CA-EXCEPT-ENV\n')
    fs.writeFileSync(path.join(sub, 'plain.txt'), 'CANARY-CA-EXCEPT-PLAIN\n')
    const settingsFile = path.join(root, 'settings.json')
    fs.writeFileSync(settingsFile, JSON.stringify(testSettings()))
    const run = (cmd) => {
      try {
        return { failed: false, output: execFileSync(process.execPath, [seatbelt, '--settings', settingsFile, '--', ...cmd], { encoding: 'utf8', timeout: 15000 }) }
      } catch (err) {
        return { failed: true, output: String(err.stdout || '') + String(err.stderr || '') }
      }
    }
    const denied = run(['/bin/cat', path.join(sub, '.env')])
    assert.ok(denied.failed || !denied.output.includes('CANARY-CA-EXCEPT-ENV'), `denied .env read leaked its canary:\n${denied.output}`)
    const allowed = run(['/bin/cat', path.join(sub, 'plain.txt')])
    assert.ok(!allowed.failed && allowed.output.includes('CANARY-CA-EXCEPT-PLAIN'), `allow control unreadable:\n${allowed.output}`)
    const ca = run(['/bin/cat', bundle])
    assert.ok(!ca.failed && ca.output.length > 0, `CA bundle unreadable under the excepted profile:\n${ca.output}`)
    const evil = path.join(sub, 'evil.pem')
    run(['/bin/sh', '-c', `echo planted > ${evil}`])
    assert.ok(!fs.existsSync(evil), 'denied .pem write landed inside the sandbox')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
