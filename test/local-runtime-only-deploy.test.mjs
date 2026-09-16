/**
 * Guarded `local-runtime-only` deploy path, tested against the real hook
 * scripts with real `git push` calls into throwaway bare repositories.
 *
 * The hooks live outside git (~/work/deploy/hooks); these tests drive them
 * through temp wrappers so the live daemon, live deploy repos, and Fly are
 * never touched: kickstart runs against a PATH shim, HOME/DEPLOY_ROOT point at
 * temp dirs, and no `main` push ever reaches the accept path (which would
 * build and fly-deploy).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const HOOKS_DIR = '/Users/skip/work/deploy/hooks'
const PRE_RECEIVE = path.join(HOOKS_DIR, 'pre-receive-common.sh')
const POST_RECEIVE_DEPLOY = path.join(HOOKS_DIR, 'post-receive-deploy.sh')

const OPTION = 'local-runtime-only'
const DAEMON_REF = 'refs/heads/daemon'

function sh(cmd, opts = {}) {
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts })
}

function git(dir, ...args) {
  return execFileSync('git', [`--git-dir=${dir}`, ...args], { encoding: 'utf8' }).trim()
}

// Throwaway world: source repo with a committable tree, bare deploy repo with
// hooks wired to the REAL hook scripts via temp wrappers.
function makeWorld({ repoName = 'testing' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-only-'))
  const home = path.join(tmp, 'home')
  const deployRoot = path.join(tmp, 'deploy')
  const src = path.join(tmp, 'src')
  const bare = path.join(deployRoot, repoName)
  const checkout = path.join(tmp, 'runtime-checkout')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(src, { recursive: true })

  sh(`git init -q -b main ${src}`)
  sh(`git -C ${src} config user.email t@t && git -C ${src} config user.name t`)
  fs.mkdirSync(path.join(src, 'server'), { recursive: true })
  fs.writeFileSync(path.join(src, 'server', 'ok.mjs'), 'export const ok = 1\n')
  sh(`git -C ${src} add -A && git -C ${src} commit -qm one`)

  sh(`git init -q --bare ${bare}`)
  // Push options are only delivered when the receiver advertises them; the
  // production testing repo needs the same config (a setup step, in docs).
  sh(`git --git-dir=${bare} config receive.advertisePushOptions true`)
  // Seed objects and refs with plumbing — no hooks involved.
  sh(`git --git-dir=${bare} fetch -q ${src} main:refs/heads/main`)
  sh(`git clone -q --local ${bare} ${checkout}`)

  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const daemonLog = path.join(home, '.config', 'tlda', `fleet-daemon.${repoName}.log`)
  fs.mkdirSync(path.dirname(daemonLog), { recursive: true })
  fs.writeFileSync(daemonLog, '')
  // Fake launchctl: records calls; a successful kickstart appends the runtime
  // stamp the real daemon would log at boot, so the hook's loaded-SHA poll
  // exercises its success path.
  const callsLog = path.join(tmp, 'launchctl-calls.log')
  fs.writeFileSync(path.join(bin, 'launchctl'), [
    '#!/usr/bin/env bash',
    `echo "$@" >> ${callsLog}`,
    'if [[ "$1" == "kickstart" ]]; then',
    `  printf '%s\\n' "$FAKE_STAMP_LINE" >> ${daemonLog}`,
    '  exit ${FAKE_KICKSTART_EXIT:-0}',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 })

  const envBase = {
    DEPLOY_REPO_NAME: repoName,
    DEPLOY_ROOT: deployRoot,
    DEPLOY_FLY_CONFIG: 'fly.live.toml',
    DEPLOY_RUNTIME_CHECKOUT: checkout,
    DEPLOY_DAEMON_LABEL: `com.tlda.fleet-daemon.${repoName}.test-does-not-exist`,
    DEPLOY_VERIFY_TIMEOUT: '10',
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`,
  }
  const hooksDir = path.join(bare, 'hooks')
  fs.writeFileSync(path.join(hooksDir, 'pre-receive'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `export DEPLOY_REPO_NAME=${repoName}`,
    `export DEPLOY_TESTING_REPO=${bare}`,
    `export DEPLOY_CANONICAL_REPO=${src}/.git`,
    'export DEPLOY_FLY_CONFIG=fly.live.toml',
    'export DEPLOY_FLY_APP=test-app',
    'export DEPLOY_EDGE_UPSTREAM=test.internal:5176',
    'export DEPLOY_HEALTH_URL=http://127.0.0.1:9',
    `export DEPLOY_ROOT=${deployRoot}`,
    ...Object.entries(envBase).filter(([k]) => !['DEPLOY_REPO_NAME', 'DEPLOY_ROOT', 'DEPLOY_FLY_CONFIG'].includes(k))
      .map(([k, v]) => `export ${k}=${v}`),
    `exec ${PRE_RECEIVE}`,
    '',
  ].join('\n'), { mode: 0o755 })
  fs.writeFileSync(path.join(hooksDir, 'post-receive'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    ...Object.entries(envBase).map(([k, v]) => `export ${k}=${v}`),
    `exec ${POST_RECEIVE_DEPLOY}`,
    '',
  ].join('\n'), { mode: 0o755 })

  const shaOfMain = () => git(bare, 'rev-parse', 'refs/heads/main')
  const push = (refspec, options = [], extraEnv = {}) => {
    const args = ['push', ...options.flatMap(o => ['-o', o]), bare]
    if (refspec) args.push(refspec)
    return spawnSync('git', ['-C', src, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...envBase, ...extraEnv },
    })
  }
  return { tmp, home, deployRoot, src, bare, checkout, daemonLog, callsLog, envBase, shaOfMain, push }
}

test('hook scripts under test are the live files', () => {
  assert.ok(fs.existsSync(PRE_RECEIVE), 'pre-receive-common.sh exists')
  assert.ok(fs.existsSync(POST_RECEIVE_DEPLOY), 'post-receive-deploy.sh exists')
})

test('pre-receive rejects the daemon ref without the explicit option', () => {
  const w = makeWorld()
  const sha = sh(`git -C ${w.src} rev-parse HEAD`).trim()
  const r = w.push(`${sha}:${DAEMON_REF}`)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /local-runtime-only/)
  assert.throws(() => git(w.bare, 'rev-parse', '--verify', DAEMON_REF))
})

test('pre-receive rejects main carrying the local-runtime-only option', () => {
  const w = makeWorld()
  sh(`git -C ${w.src} commit -q --allow-empty -m two`)
  const sha = sh(`git -C ${w.src} rev-parse HEAD`).trim()
  const r = w.push(`${sha}:refs/heads/main`, [OPTION])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /local-runtime-only/)
  assert.equal(w.shaOfMain() === sha, false)
})

test('pre-receive still rejects unrelated refs', () => {
  const w = makeWorld()
  const sha = sh(`git -C ${w.src} rev-parse HEAD`).trim()
  const r = w.push(`${sha}:refs/heads/wiring-probe`)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /only refs\/heads\/main is deployable/)
})

test('pre-receive rejects the daemon ref outside testing', () => {
  const w = makeWorld({ repoName: 'stable' })
  const sha = sh(`git -C ${w.src} rev-parse HEAD`).trim()
  const r = w.push(`${sha}:${DAEMON_REF}`, [OPTION])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /testing/)
})

test('explicit override: daemon ref with the option is accepted and moves only the runtime checkout', (t) => {
  const w = makeWorld()
  sh(`git -C ${w.src} commit -q --allow-empty -m candidate`)
  const sha = sh(`git -C ${w.src} rev-parse HEAD`).trim()
  const stamp = `tlda-runtime sha=${sha} root=${w.checkout} env=testing`
  const r = w.push(`${sha}:${DAEMON_REF}`, [OPTION], { FAKE_STAMP_LINE: stamp })
  assert.equal(r.status, 0, `push failed: ${r.stderr}`)
  assert.equal(git(w.bare, 'rev-parse', DAEMON_REF), sha)
  // Fly/server ref untouched.
  assert.notEqual(w.shaOfMain(), sha)
  // Runtime checkout reset to the override SHA.
  assert.equal(sh(`git -C ${w.checkout} rev-parse HEAD`).trim(), sha)
  // Override marker records the selected SHA.
  assert.equal(fs.readFileSync(path.join(w.deployRoot, 'testing', 'deploy-state', 'runtime-sha'), 'utf8').trim(), sha)
  // Loaded-SHA verification saw the boot stamp: restart reported, not old code.
  assert.match(r.stderr + r.stdout, /now on .* restarted/)
  assert.doesNotMatch(r.stderr + r.stdout, /OLD code/)
  // Server-deployment record untouched by the override: no main push happened
  // here, so the file must not exist — the override never writes it.
  assert.equal(fs.existsSync(path.join(w.deployRoot, 'testing', 'deploy-state', 'last-successful-sha')), false)
})

test('failed restart is reported, never silent', () => {
  const w = makeWorld()
  sh(`git -C ${w.src} commit -q --allow-empty -m candidate`)
  const sha = sh(`git -C ${w.src} rev-parse HEAD`).trim()
  const r = w.push(`${sha}:${DAEMON_REF}`, [OPTION], { FAKE_KICKSTART_EXIT: '1', FAKE_STAMP_LINE: '' })
  assert.equal(r.status, 0, `push failed: ${r.stderr}`)
  assert.match(r.stderr + r.stdout, /OLD code/)
})

test('ordinary main behavior is preserved: post-receive syncs the checkout to main', () => {
  const w = makeWorld()
  // Drive post-receive directly: a main push would fly-deploy, so the accept
  // path for main is covered here at the receive layer.
  const out = sh(`printf '%s %s %s\\n' 0000000000000000000000000000000000000000 ${w.shaOfMain()} refs/heads/main | bash ${path.join(w.bare, 'hooks', 'post-receive')}`, {
    env: { ...process.env, ...w.envBase, FAKE_STAMP_LINE: `tlda-runtime sha=${w.shaOfMain()} root=${w.checkout} env=testing` },
  })
  assert.match(out, /now on .* restarted/)
  assert.equal(sh(`git -C ${w.checkout} rev-parse HEAD`).trim(), w.shaOfMain())
  assert.equal(fs.readFileSync(path.join(w.deployRoot, 'testing', 'deploy-state', 'last-successful-sha'), 'utf8').trim(), w.shaOfMain())
})

test('full-deploy reunification clears the override', () => {
  const w = makeWorld()
  sh(`git -C ${w.src} commit -q --allow-empty -m candidate`)
  const overrideSha = sh(`git -C ${w.src} rev-parse HEAD`).trim()
  const r1 = w.push(`${overrideSha}:${DAEMON_REF}`, [OPTION], {
    FAKE_STAMP_LINE: `tlda-runtime sha=${overrideSha} root=${w.checkout} env=testing`,
  })
  assert.equal(r1.status, 0, `override push failed: ${r1.stderr}`)
  assert.equal(git(w.bare, 'rev-parse', DAEMON_REF), overrideSha)

  const out = sh(`printf '%s %s %s\\n' x ${w.shaOfMain()} refs/heads/main | bash ${path.join(w.bare, 'hooks', 'post-receive')}`, {
    env: { ...process.env, ...w.envBase, FAKE_STAMP_LINE: `tlda-runtime sha=${w.shaOfMain()} root=${w.checkout} env=testing` },
  })
  assert.match(out, /reunif/i)
  assert.throws(() => git(w.bare, 'rev-parse', '--verify', DAEMON_REF))
  assert.equal(fs.existsSync(path.join(w.deployRoot, 'testing', 'deploy-state', 'runtime-sha')), false)
  assert.equal(sh(`git -C ${w.checkout} rev-parse HEAD`).trim(), w.shaOfMain())
})

test('docs and hooks name the real option/ref contract', () => {
  const root = new URL('..', import.meta.url).pathname
  const liveDeploy = fs.readFileSync(path.join(root, 'docs/live-deploy.md'), 'utf8')
  const pre = fs.readFileSync(PRE_RECEIVE, 'utf8')
  const post = fs.readFileSync(POST_RECEIVE_DEPLOY, 'utf8')
  // The invariant lives in docs/live-deploy.md (repo AGENTS.md is Skip's file;
  // agents leave it alone) plus the event-scoped copy owned outside this repo.
  assert.ok(liveDeploy.includes(`-o ${OPTION}`), 'docs/live-deploy.md names the push option')
  assert.ok(liveDeploy.includes(DAEMON_REF), 'live-deploy.md names the runtime ref')
  assert.ok(liveDeploy.includes('runtimeRoot'), 'live-deploy.md names runtimeRoot')
  for (const [name, text] of [['pre-receive-common.sh', pre], ['post-receive-deploy.sh', post]]) {
    assert.ok(text.includes(OPTION), `${name} implements the option`)
    assert.ok(text.includes(DAEMON_REF), `${name} implements the ref`)
  }
  assert.ok(post.includes('tlda-runtime'), 'post-receive polls the runtime boot stamp')
})
