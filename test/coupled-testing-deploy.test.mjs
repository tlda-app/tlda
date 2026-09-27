/**
 * Coupled testing deploy: one testing push moves the testing server
 * (fly.live.toml) AND its build executor on the pic-dev box
 * (fly.pic-dev.toml) from the same sha.
 *
 * The server refuses a remote build unless the executor reports the server's
 * own revision (`requireMatchingExecutorRevision`), so deploying the two
 * boxes through two separate pushes leaves a window where every build fails
 * with a revision mismatch. The coupled path builds once and deploys both
 * boxes from that one checkout, verifying each serves the pushed sha.
 *
 * Tested against the real hook scripts with real `git push` calls into
 * throwaway bare repositories, following test/local-runtime-only-deploy.test.mjs.
 * Only the effects outside the hook are shimmed via PATH: `fly` (records its
 * invocations instead of deploying), `pnpm` (records instead of building) and
 * `curl` (answers /api/build-info from FAKE_SERVING_SHA instead of dialing).
 * git, node, tar and ps are real. TMPDIR points at the throwaway world so the
 * hook's checkout sweep can never touch a real in-flight deploy, and the
 * health URLs use .invalid so a missing shim fails loudly instead of dialing.
 *
 * PRE_RECEIVE_UNDER_TEST overrides which pre-receive script the wrappers exec,
 * so this suite can run against the pre-change hook (where the coupling tests
 * fail) as well as the live one (where they pass).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const HOOKS_DIR = '/Users/skip/work/deploy/hooks'
const PRE_RECEIVE = process.env.PRE_RECEIVE_UNDER_TEST || path.join(HOOKS_DIR, 'pre-receive-common.sh')
const POST_RECEIVE_DEPLOY = path.join(HOOKS_DIR, 'post-receive-deploy.sh')
const TESTING_WRAPPER = '/Users/skip/work/deploy/testing/hooks/pre-receive'

const PRIMARY_CONFIG = 'fly.live.toml'
const COUPLED_CONFIG = 'fly.pic-dev.toml'
const PRIMARY_HEALTH = 'https://tlda-fly.test.invalid'
const COUPLED_HEALTH = 'https://tlda-pic-dev.test.invalid'

function sh(cmd, opts = {}) {
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts })
}

function git(dir, ...args) {
  return execFileSync('git', [`--git-dir=${dir}`, ...args], { encoding: 'utf8' }).trim()
}

// Throwaway world: source repo with a committable tree, bare deploy repo with
// hooks wired to the hook script under test via temp wrappers.
function makeWorld({ repoName = 'testing', coupled = `${COUPLED_CONFIG}=${COUPLED_HEALTH}` } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coupled-deploy-'))
  const home = path.join(tmp, 'home')
  const deployRoot = path.join(tmp, 'deploy')
  const tmpdir = path.join(tmp, 'tmp')
  const src = path.join(tmp, 'src')
  const bare = path.join(deployRoot, repoName)
  for (const dir of [home, src, tmpdir]) fs.mkdirSync(dir, { recursive: true })

  sh(`git init -q -b main ${src}`)
  sh(`git -C ${src} config user.email t@t && git -C ${src} config user.name t`)
  fs.mkdirSync(path.join(src, 'server'), { recursive: true })
  fs.writeFileSync(path.join(src, 'server', 'ok.mjs'), 'export const ok = 1\n')
  // Primary config carries the private-config sentinels the testing hook
  // substitutes, plus an edge process line so the test pins per-config
  // --process-groups handling: the app deploy leaves the tailnet edge alone.
  fs.writeFileSync(path.join(src, PRIMARY_CONFIG), [
    'app = "your-tlda-live"',
    '[processes]',
    '  app = "/app/fly-entrypoint-live.sh"',
    '  edge = "/app/fly-entrypoint-edge.sh"',
    'TLDA_EDGE_UPSTREAM = "app.process.your-tlda-live.internal:5176"',
    '',
  ].join('\n'))
  // Coupled config deploys as it stands: no sentinels, no edge group.
  fs.writeFileSync(path.join(src, COUPLED_CONFIG), [
    'app = "tlda-pic-dev-test"',
    '[env]',
    '  PORT = "5176"',
    '',
  ].join('\n'))
  sh(`git -C ${src} add -A && git -C ${src} commit -qm one`)

  sh(`git init -q -b main --bare ${bare}`)
  sh(`git --git-dir=${bare} fetch -q ${src} main:refs/heads/main`)

  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const flyLog = path.join(tmp, 'fly-calls.log')
  const pnpmLog = path.join(tmp, 'pnpm-calls.log')
  const curlLog = path.join(tmp, 'curl-calls.log')
  fs.writeFileSync(path.join(bin, 'fly'), [
    '#!/usr/bin/env bash',
    `echo "$@" >> ${flyLog}`,
    'if [[ -n "${FAKE_FLY_FAIL_CONFIG:-}" && "$*" == *"$FAKE_FLY_FAIL_CONFIG"* ]]; then',
    '  echo "fake fly: refusing $FAKE_FLY_FAIL_CONFIG" >&2',
    '  exit 1',
    'fi',
    'exit ${FAKE_FLY_EXIT:-0}',
    '',
  ].join('\n'), { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'pnpm'), [
    '#!/usr/bin/env bash',
    `echo "$@" >> ${pnpmLog}`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/usr/bin/env bash',
    'url=""',
    'for arg in "$@"; do url="$arg"; done',
    `echo "$url" >> ${curlLog}`,
    'if [[ -n "${FAKE_FAIL_URL_SUBSTR:-}" && "$url" == *"$FAKE_FAIL_URL_SUBSTR"* ]]; then',
    '  printf \'{"gitSha":"0000000000000000000000000000000000000000"}\'',
    'else',
    '  printf \'{"gitSha":"%s"}\' "${FAKE_SERVING_SHA:?FAKE_SERVING_SHA is required}"',
    'fi',
    '',
  ].join('\n'), { mode: 0o755 })

  const envBase = {
    DEPLOY_REPO_NAME: repoName,
    DEPLOY_ROOT: deployRoot,
    DEPLOY_FLY_CONFIG: PRIMARY_CONFIG,
    DEPLOY_HEALTH_URL: PRIMARY_HEALTH,
    DEPLOY_VERIFY_TIMEOUT_SECONDS: '30',
    HOME: home,
    TMPDIR: tmpdir,
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
  }
  const hooksDir = path.join(bare, 'hooks')
  const wrapper = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export DEPLOY_REPO_NAME=${repoName}`,
    `export DEPLOY_TESTING_REPO=${bare}`,
    `export DEPLOY_FLY_CONFIG=${PRIMARY_CONFIG}`,
    `export DEPLOY_HEALTH_URL=${PRIMARY_HEALTH}`,
    `export DEPLOY_ROOT=${deployRoot}`,
  ]
  if (repoName === 'testing') {
    wrapper.push(
      `export DEPLOY_CANONICAL_REPO=${src}/.git`,
      'export DEPLOY_FLY_APP=test-app',
      'export DEPLOY_EDGE_UPSTREAM=test.internal:5176',
    )
  }
  if (coupled) wrapper.push(`export DEPLOY_COUPLED_DEPLOYS="${coupled}"`)
  wrapper.push(`exec ${PRE_RECEIVE}`, '')
  fs.writeFileSync(path.join(hooksDir, 'pre-receive'), wrapper.join('\n'), { mode: 0o755 })
  fs.writeFileSync(path.join(hooksDir, 'post-receive'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...Object.entries({ DEPLOY_REPO_NAME: repoName, DEPLOY_ROOT: deployRoot, HOME: home, TMPDIR: tmpdir })
      .map(([k, v]) => `export ${k}=${v}`),
    `exec ${POST_RECEIVE_DEPLOY}`,
    '',
  ].join('\n'), { mode: 0o755 })

  const readLog = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')
  const shaOfMain = () => git(bare, 'rev-parse', 'refs/heads/main')
  const push = (refspec, extraEnv = {}) => spawnSync('git', ['-C', src, 'push', bare, refspec], {
    encoding: 'utf8',
    env: { ...process.env, ...envBase, ...extraEnv },
  })
  const commitMore = (message = 'two') => {
    sh(`git -C ${src} commit -q --allow-empty -m ${message}`)
    return sh(`git -C ${src} rev-parse HEAD`).trim()
  }
  return {
    tmp, home, deployRoot, tmpdir, src, bare, bin, envBase,
    flyCalls: () => readLog(flyLog).trim().split('\n').filter(Boolean),
    pnpmCalls: () => readLog(pnpmLog).trim().split('\n').filter(Boolean),
    curlCalls: () => readLog(curlLog).trim().split('\n').filter(Boolean),
    locksDir: () => path.join(deployRoot, 'locks'),
    shaOfMain, push, commitMore,
  }
}

test('hook scripts under test are the live files', () => {
  assert.ok(fs.existsSync(PRE_RECEIVE), 'pre-receive-common.sh exists')
  assert.ok(fs.existsSync(POST_RECEIVE_DEPLOY), 'post-receive-deploy.sh exists')
  assert.ok(fs.existsSync(TESTING_WRAPPER), 'testing pre-receive wrapper exists')
})

test('one testing push deploys the server and the executor from one sha', () => {
  const w = makeWorld()
  const sha = w.commitMore()
  const before = w.shaOfMain()
  const r = w.push(`${sha}:refs/heads/main`, { FAKE_SERVING_SHA: sha })
  assert.equal(r.status, 0, `push failed: ${r.stderr}`)
  assert.equal(w.shaOfMain(), sha)

  // Both apps deployed, server first, from the single build below.
  const fly = w.flyCalls()
  assert.equal(fly.length, 2, `expected two fly deploys, saw: ${JSON.stringify(fly)}`)
  assert.match(fly[0], /\.fly\.testing\.toml/, 'server deploys through the private testing config')
  assert.match(fly[0], /--process-groups app/, 'server deploy leaves the edge group alone')
  assert.match(fly[1], new RegExp(`-c ${COUPLED_CONFIG}$`), 'executor deploys from its own config')
  assert.doesNotMatch(fly[1], /--process-groups/, 'executor has no edge group to spare')

  // Each box verified serving the pushed sha.
  const curl = w.curlCalls()
  assert.ok(curl.some(url => url.startsWith(`${PRIMARY_HEALTH}/api/build-info`)), `server health probed: ${JSON.stringify(curl)}`)
  assert.ok(curl.some(url => url.startsWith(`${COUPLED_HEALTH}/api/build-info`)), `executor health probed: ${JSON.stringify(curl)}`)

  // One build for both deploys.
  const builds = w.pnpmCalls().filter(line => line === 'run build')
  assert.equal(builds.length, 1, `expected one build, saw: ${JSON.stringify(w.pnpmCalls())}`)

  // Both locks were taken and released.
  const output = `${r.stderr}${r.stdout}`
  assert.match(output, new RegExp(`deploy lock: held for ${PRIMARY_CONFIG}`))
  assert.match(output, new RegExp(`deploy lock: held for ${COUPLED_CONFIG}`))
  const leftovers = fs.existsSync(w.locksDir()) ? fs.readdirSync(w.locksDir()) : []
  assert.deepEqual(leftovers, [], 'no lock survives a successful coupled push')
  assert.notEqual(before, sha, 'the push moved the ref')
})

test('a coupled box that never serves the sha rejects the push', () => {
  const w = makeWorld()
  const sha = w.commitMore()
  const before = w.shaOfMain()
  const r = w.push(`${sha}:refs/heads/main`, {
    FAKE_SERVING_SHA: sha,
    FAKE_FAIL_URL_SUBSTR: 'tlda-pic-dev',
    DEPLOY_VERIFY_TIMEOUT_SECONDS: '10',
  })
  assert.notEqual(r.status, 0, 'push must be rejected when the executor never serves the sha')
  assert.match(r.stderr, /did not reach the box/)
  assert.equal(w.shaOfMain(), before, 'the ref does not move on a failed coupled deploy')
  assert.equal(w.flyCalls().length, 2, 'both boxes were attempted before the refusal')
})

test('coupled deploys are refused outside testing', () => {
  const w = makeWorld({ repoName: 'pic-dev' })
  const sha = w.commitMore()
  const before = w.shaOfMain()
  const r = w.push(`${sha}:refs/heads/main`, { FAKE_SERVING_SHA: sha })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /supported only for testing/)
  assert.equal(w.shaOfMain(), before)
  assert.deepEqual(w.flyCalls(), [], 'nothing deploys on a refused coupled config')
})

test('a malformed coupled entry is rejected before anything builds', () => {
  const w = makeWorld({ coupled: 'not-a-pair' })
  const sha = w.commitMore()
  const before = w.shaOfMain()
  const r = w.push(`${sha}:refs/heads/main`, { FAKE_SERVING_SHA: sha })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /must be config=health-url/)
  assert.equal(w.shaOfMain(), before)
  assert.deepEqual(w.pnpmCalls(), [], 'a malformed coupled config fails before the build')
  assert.deepEqual(w.flyCalls(), [], 'a malformed coupled config fails before any deploy')
})

test('a held coupled-app lock refuses the push', () => {
  const w = makeWorld()
  const sha = w.commitMore()
  const before = w.shaOfMain()
  // A live holder: this test process, with its start time normalized exactly
  // as the hook's holder_signature does (squeeze, no trim -- ps pads a
  // leading space that trimming would remove, and the hook would then read
  // the lock as abandoned and clear it).
  const sig = sh(`ps -o lstart= -p ${process.pid} 2>/dev/null | tr -s ' '`).replace(/\n$/, '')
  fs.mkdirSync(w.locksDir(), { recursive: true })
  fs.writeFileSync(path.join(w.locksDir(), `${COUPLED_CONFIG}.lock`), `${process.pid}\t${sig}\ttest holder\n`)
  const r = w.push(`${sha}:refs/heads/main`, { FAKE_SERVING_SHA: sha })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, new RegExp(`a deploy to ${COUPLED_CONFIG} is already running`))
  assert.equal(w.shaOfMain(), before)
  assert.deepEqual(w.flyCalls(), [], 'a refused push builds and deploys nothing')
})

test('without coupled config, one app deploys exactly as before', () => {
  const w = makeWorld({ coupled: '' })
  const sha = w.commitMore()
  const r = w.push(`${sha}:refs/heads/main`, { FAKE_SERVING_SHA: sha })
  assert.equal(r.status, 0, `push failed: ${r.stderr}`)
  assert.equal(w.shaOfMain(), sha)
  const fly = w.flyCalls()
  assert.equal(fly.length, 1, `expected one fly deploy, saw: ${JSON.stringify(fly)}`)
  assert.match(fly[0], /\.fly\.testing\.toml/)
  assert.equal(w.curlCalls().length, 1, 'only the primary box is verified')
})

test('docs, hook and wrapper name the coupling contract', () => {
  const root = new URL('..', import.meta.url).pathname
  const liveDeploy = fs.readFileSync(path.join(root, 'docs/live-deploy.md'), 'utf8')
  const pre = fs.readFileSync(path.join(HOOKS_DIR, 'pre-receive-common.sh'), 'utf8')
  const wrapper = fs.readFileSync(TESTING_WRAPPER, 'utf8')
  assert.ok(pre.includes('DEPLOY_COUPLED_DEPLOYS'), 'pre-receive-common.sh implements coupled deploys')
  assert.ok(wrapper.includes('DEPLOY_COUPLED_DEPLOYS'), 'testing wrapper couples its executor')
  assert.ok(wrapper.includes(COUPLED_CONFIG), 'testing wrapper names the executor config')
  assert.ok(liveDeploy.includes('DEPLOY_COUPLED_DEPLOYS'), 'docs/live-deploy.md names the coupling variable')
  assert.ok(liveDeploy.includes('fly.pic-dev.toml'), 'docs/live-deploy.md names the executor box')
  assert.ok(
    liveDeploy.includes('publication owns'),
    'docs/live-deploy.md records that publication owns the published runtime',
  )
})
