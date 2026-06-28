import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runLiveDeployPreflight } from '../scripts/live-deploy-preflight.mjs'

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-live-preflight-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'TLDA Test'])
  writeFileSync(join(dir, '.gitignore'), 'server/build-info.json\n')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  git(dir, ['add', '.gitignore', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
  return dir
}

test('live deploy preflight refuses dirty checkout before writing stamp', () => {
  const repo = makeRepo()
  try {
    const stamp = join(repo, 'server', 'build-info.json')
    writeFileSync(join(repo, 'README.md'), 'dirty\n')

    assert.throws(
      () => runLiveDeployPreflight({ repoRoot: repo, now: new Date('2026-06-28T12:00:00.000Z') }),
      /uncommitted changes/,
    )
    assert.equal(existsSync(stamp), false)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('live deploy preflight writes stamp for clean checkout without dirtying it', () => {
  const repo = makeRepo()
  try {
    const sha = git(repo, ['rev-parse', 'HEAD'])
    const result = runLiveDeployPreflight({
      repoRoot: repo,
      now: new Date('2026-06-28T12:00:00.000Z'),
    })
    const stamp = JSON.parse(readFileSync(join(repo, 'server', 'build-info.json'), 'utf8'))

    assert.equal(result.buildInfo.gitSha, sha)
    assert.equal(stamp.gitSha, sha)
    assert.equal(stamp.sha, sha)
    assert.equal(stamp.ref, 'main')
    assert.equal(stamp.branch, 'main')
    assert.equal(stamp.dirty, false)
    assert.equal(stamp.builtAt, '2026-06-28T12:00:00.000Z')
    assert.equal(git(repo, ['status', '--porcelain=v1']), '')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('live deploy preflight has no fly/deploy side effects', () => {
  const repo = makeRepo()
  try {
    let wroteStamp = false
    const result = runLiveDeployPreflight({
      repoRoot: repo,
      now: new Date('2026-06-28T12:00:00.000Z'),
      resolveIdentity: () => ({
        checkoutPath: repo,
        gitSha: 'abc123',
        ref: 'main',
        branch: 'main',
        dirty: false,
        isWorktree: false,
      }),
      writeFile: () => {
        wroteStamp = true
      },
    })

    assert.equal(wroteStamp, true)
    assert.equal(result.buildInfo.gitSha, 'abc123')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('live deploy preflight CLI does not invoke fly even when fly is on PATH', () => {
  const repo = makeRepo()
  const tools = mkdtempSync(join(tmpdir(), 'tlda-live-preflight-tools-'))
  try {
    const fly = join(tools, 'fly')
    mkdirSync(join(repo, 'server'), { recursive: true })
    writeFileSync(fly, '#!/bin/sh\necho "fly must not run" >&2\nexit 99\n')
    chmodSync(fly, 0o755)

    const res = spawnSync(process.execPath, [new URL('../scripts/live-deploy-preflight.mjs', import.meta.url).pathname, '--repo', repo], {
      cwd: repo,
      env: { ...process.env, PATH: `${tools}:${process.env.PATH || ''}` },
      encoding: 'utf8',
    })

    assert.equal(res.status, 0, res.stderr)
    assert.doesNotMatch(res.stderr, /fly must not run/)
    assert.equal(existsSync(join(repo, 'server', 'build-info.json')), true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
    rmSync(tools, { recursive: true, force: true })
  }
})
