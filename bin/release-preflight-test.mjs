import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '..')
const releaseScript = path.join(repoRoot, 'bin', 'release.sh')

async function withMockGit(run) {
  const mockDir = await mkdtemp(path.join(tmpdir(), 'tlda-release-preflight-'))
  const git = path.join(mockDir, 'git')
  await writeFile(git, `#!/bin/bash
case "$*" in
  "status --porcelain") exit 0 ;;
  "branch --show-current") echo main ;;
  "remote get-url origin") echo git@github.com:tlda-app/tlda.git ;;
  "rev-parse --verify --quiet refs/tags/v0.3.1")
    [[ "\${MOCK_TAG_EXISTS:-}" == 1 ]] && exit 0
    exit 1
    ;;
  "ls-remote --tags origin refs/tags/v0.3.1") exit 0 ;;
  "ls-remote origin refs/heads/main") printf 'release-sha\\trefs/heads/main\\n' ;;
  "rev-parse HEAD") echo release-sha ;;
  *) echo "unexpected git call: $*" >&2; exit 2 ;;
esac
`)
  await chmod(git, 0o755)
  try {
    await run({ ...process.env, PATH: `${mockDir}:${process.env.PATH}` })
  } finally {
    await rm(mockDir, { recursive: true, force: true })
  }
}

function release(args, env) {
  return spawnSync('bash', [releaseScript, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  })
}

test('release dry-run accepts the package version and makes no release changes', async () => {
  await withMockGit((env) => {
    const result = release(['v0.3.1', '--dry-run'], env)
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /Release preflight passed for v0\.3\.1 at release-sha/)
    assert.match(result.stdout, /github\.com\/tlda-app\/tlda/)
  })
})

test('release requires an explicit version matching package.json', async () => {
  await withMockGit((env) => {
    const missing = release([], env)
    assert.equal(missing.status, 1)
    assert.match(missing.stdout, /Usage:/)

    const mismatch = release(['v0.4.0', '--dry-run'], env)
    assert.equal(mismatch.status, 1)
    assert.match(mismatch.stdout, /does not match package version 0\.3\.1/)
  })
})

test('release refuses to move an existing local tag', async () => {
  await withMockGit((env) => {
    const result = release(['v0.3.1', '--dry-run'], { ...env, MOCK_TAG_EXISTS: '1' })
    assert.equal(result.status, 1)
    assert.match(result.stdout, /already exists locally/)
  })
})
