import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  declaredLaunchdEnvNames,
  escapePlistString,
  formatMissingLaunchdEnvWarning,
  renderEnvironmentPlist,
  resolveLaunchdEnv,
} from './config-apply-env.mjs'
import { planLaunchdApply } from './config-apply-plan.mjs'
import {
  validateDaemonConfigTopLevel,
  validateLaunchdEnv,
} from '../../shared/daemon-config-schema.mjs'

// Convergent apply env secrets: names declared in daemon.yaml (`launchdEnv`),
// values read from the applying process's environment, rendered into the
// fleet-daemon plist by the generator. Same config plus same environment must
// give the same plist; undeclared extras on disk are dropped; declared-but-
// missing names warn and continue.
//
// Values below are fakes. Assertions match on key presence and hashes, and the
// warning-format case asserts the value string is absent from the output.

const FAKE_ENV = {
  TLDA_TEST_DECLARED_ONE: 'fake-value-one',
  TLDA_TEST_DECLARED_TWO: 'fake-value-two&<>"\'',
}
const DECLARED = ['TLDA_TEST_DECLARED_ONE', 'TLDA_TEST_DECLARED_TWO']

// The real wiring renders template entries plus resolved entries through one
// renderer; this template stands in for the static plist around the
// EnvironmentVariables dict.
function buildPlist(templateEntries, extraEntries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<dict>',
    '<key>EnvironmentVariables</key>',
    '<dict>',
    renderEnvironmentPlist([...templateEntries, ...extraEntries]),
    '</dict>',
    '</dict>',
  ].join('\n')
}

const TEMPLATE_ENTRIES = [['PATH', '/usr/bin:/bin'], ['TLDA_ENV', 'testing']]

function sha(text) {
  return createHash('sha256').update(text).digest('hex')
}

test('declared names resolve to entries; undeclared environment is ignored', () => {
  const { entries, missing } = resolveLaunchdEnv(DECLARED, {
    env: { ...FAKE_ENV, TLDA_TEST_UNDECLARED: 'should-never-appear' },
    reserved: TEMPLATE_ENTRIES.map(([key]) => key),
  })
  assert.deepEqual(missing, [])
  assert.deepEqual(entries, [
    ['TLDA_TEST_DECLARED_ONE', 'fake-value-one'],
    ['TLDA_TEST_DECLARED_TWO', 'fake-value-two&<>"\''],
  ])
})

test('declared-but-missing names are collected, not thrown', () => {
  const { entries, missing } = resolveLaunchdEnv(
    ['TLDA_TEST_DECLARED_ONE', 'TLDA_TEST_ABSENT'],
    { env: FAKE_ENV },
  )
  assert.deepEqual(missing, ['TLDA_TEST_ABSENT'])
  assert.deepEqual(entries, [['TLDA_TEST_DECLARED_ONE', 'fake-value-one']])
})

test('same config plus same environment resolves identically', () => {
  const first = resolveLaunchdEnv(DECLARED, { env: FAKE_ENV })
  const second = resolveLaunchdEnv(DECLARED, { env: FAKE_ENV })
  assert.deepEqual(first, second)
  assert.equal(sha(buildPlist(TEMPLATE_ENTRIES, first.entries)), sha(buildPlist(TEMPLATE_ENTRIES, second.entries)))
})

test('declared key survives into desired content; undeclared on-disk extra is dropped by convergence', () => {
  const { entries } = resolveLaunchdEnv(DECLARED, { env: FAKE_ENV })
  const desired = buildPlist(TEMPLATE_ENTRIES, entries)
  assert.match(desired, /<key>TLDA_TEST_DECLARED_ONE<\/key>\n {8}<string>fake-value-one<\/string>/)

  // The on-disk plist carries an undeclared extra and lacks the declared key.
  const onDisk = buildPlist(TEMPLATE_ENTRIES, [['TLDA_TEST_STALE_HAND_EDIT', 'stale']])
  const label = 'com.tlda.fleet-daemon.testing'
  const firstPlan = planLaunchdApply({
    desiredJobs: [{ label, plist: '/tmp/scratch.plist', content: desired }],
    existingJobs: [{ label, plist: '/tmp/scratch.plist', content: onDisk, loaded: true, loadedDefinitionMatches: true }],
  })
  assert.equal(firstPlan.update.length, 1)

  // After the apply writes desired content, the next plan is unchanged and
  // the bytes are identical: the output converged and the extra is gone.
  const secondPlan = planLaunchdApply({
    desiredJobs: [{ label, plist: '/tmp/scratch.plist', content: desired }],
    existingJobs: [{ label, plist: '/tmp/scratch.plist', content: desired, loaded: true, loadedDefinitionMatches: true }],
  })
  assert.deepEqual(secondPlan.update, [])
  assert.deepEqual(secondPlan.unchanged.length, 1)
  assert.doesNotMatch(desired, /TLDA_TEST_STALE_HAND_EDIT/)
})

test('missing-var warning names the var and carries no value', () => {
  const warning = formatMissingLaunchdEnvWarning(['TLDA_TEST_ABSENT'])
  assert.match(warning, /TLDA_TEST_ABSENT/)
  assert.doesNotMatch(warning, /fake-value-one/)
  const plural = formatMissingLaunchdEnvWarning(['TLDA_TEST_ABSENT', 'TLDA_TEST_GONE'])
  assert.match(plural, /TLDA_TEST_ABSENT/)
  assert.match(plural, /TLDA_TEST_GONE/)
})

test('declaring a template-owned key throws instead of forking the value', () => {
  assert.throws(
    () => resolveLaunchdEnv(['PATH'], { env: FAKE_ENV, reserved: ['PATH'] }),
    /already sets/,
  )
})

test('rendering escapes plist metacharacters', () => {
  assert.equal(escapePlistString('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&apos;f')
  const rendered = renderEnvironmentPlist([['TLDA_TEST_DECLARED_TWO', FAKE_ENV.TLDA_TEST_DECLARED_TWO]])
  assert.match(rendered, /fake-value-two&amp;&lt;&gt;&quot;&apos;/)
})

test('absent declaration resolves to nothing', () => {
  assert.deepEqual(declaredLaunchdEnvNames({}), [])
  assert.deepEqual(declaredLaunchdEnvNames(null), [])
  assert.deepEqual(declaredLaunchdEnvNames({ launchdEnv: undefined }), [])
})

test('schema accepts a names-only list and rejects bad shapes', () => {
  assert.deepEqual(validateLaunchdEnv(undefined), [])
  assert.deepEqual(validateLaunchdEnv(['META_API_KEY']), ['META_API_KEY'])
  assert.throws(() => validateLaunchdEnv('META_API_KEY'), /must be a list/)
  assert.throws(() => validateLaunchdEnv(['']), /must look like/)
  assert.throws(() => validateLaunchdEnv(['has space']), /must look like/)
  assert.throws(() => validateLaunchdEnv([42]), /must look like/)
  assert.throws(() => validateLaunchdEnv(['A', 'A']), /twice/)
  // The top-level gate admits the key and still shuts unknown ones.
  validateDaemonConfigTopLevel({ launchdEnv: ['META_API_KEY'] })
  assert.throws(
    () => validateDaemonConfigTopLevel({ launchdEnv: [], nope: 1 }),
    /unknown key/,
  )
})
