#!/usr/bin/env node
/**
 * CLI unit tests.
 *
 * Tests argument parsing, source file collection, hash diffing.
 * Fast — no server, no LaTeX, no browser.
 *
 * Usage:
 *   node --test test/cli.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const CTD = join(ROOT, 'cli', 'tlda.mjs')

function scrubAgentEnv(env) {
  const next = { ...env }
  for (const key of ['FLEET_ID', 'FLEET_NAME', 'FLEET_TMUX_SESSION', 'FLEET_HARNESS', 'TMUX']) {
    delete next[key]
  }
  return next
}

// Helper: run tlda with args, return { stdout, stderr, exitCode }
function tlda(...args) {
  const options = args.at(-1)
  const hasOptions = options && typeof options === 'object' && !Array.isArray(options)
  const cliArgs = hasOptions ? args.slice(0, -1) : args
  const baseEnv = hasOptions && options.env ? options.env : scrubAgentEnv(process.env)
  try {
    const stdout = execFileSync('node', [CTD, ...cliArgs], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...baseEnv, TLDA_SERVER: 'http://localhost:99999' }, // unreachable server
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (e) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status }
  }
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

describe('argument parser', () => {
  it('shows help with no args', () => {
    const { stdout } = tlda()
    assert.ok(stdout.includes('tlda — collaborative LaTeX paper review'))
    assert.ok(stdout.includes('tlda doc <cmd>'))
  })

  it('shows per-command help', () => {
    for (const cmd of ['doc', 'server', 'agent', 'config']) {
      const { stdout, exitCode } = tlda(cmd, '--help')
      assert.equal(exitCode, 0, `${cmd} --help should exit 0`)
      assert.ok(stdout.includes('tlda'), `${cmd} --help should show usage`)
    }
  })

  it('completions prints the zsh completion script', () => {
    const { stdout, exitCode } = tlda('completions')
    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('#compdef tlda'))
    assert.ok(stdout.includes("'completions:output zsh completion script'"))
  })

  it('advertised help commands exit 0 without live work', () => {
    const cases = [
      ['doc', '--help'],
      ['server', '--help'],
      ['daemon', '--help'],
      ['bot', '--help'],
      ['agent', '--help'],
      ['config', '--help'],
      ['system', '--help'],
      ['doctor', '--help'],
      ['logs', '--help'],
      ['doc', 'repo-doctor', '--help'],
    ]
    const liveWorkNeedles = [
      'Server not running',
      'Server running at',
      'fleet daemon not running',
      'Fleet daemon launchd job started',
      'No .tex file found',
      'All checks passed',
      'issues found',
      'Project "',
    ]

    for (const args of cases) {
      const { stdout, stderr, exitCode } = tlda(...args)
      assert.equal(exitCode, 0, `${args.join(' ')} should exit 0\nstdout:\n${stdout}\nstderr:\n${stderr}`)
      assert.match(stdout, /tlda/)
      for (const needle of liveWorkNeedles) {
        assert.ok(!stdout.includes(needle), `${args.join(' ')} should not run live work: ${needle}`)
        assert.ok(!stderr.includes(needle), `${args.join(' ')} should not run live work: ${needle}`)
      }
    }
  })

  it('completions use noun-first command names', () => {
    const { stdout, exitCode } = tlda('completions')
    assert.equal(exitCode, 0)
    assert.ok(stdout.includes("'doc:work on a document project'"))
    assert.ok(stdout.includes("'daemon:fleet daemon (source watch + activity)'"))
    assert.ok(!stdout.includes("'watch:"))
    assert.ok(!stdout.includes("'watch-all:"))
    assert.ok(!stdout.includes("'link:Link project"))
  })
})

// ---------------------------------------------------------------------------
// Agent lifecycle CLI
// ---------------------------------------------------------------------------

describe('agent lifecycle CLI', () => {
  it('rejects retired lifecycle verbs without aliases', () => {
    for (const verb of ['spawn', 'spawn-direct', 'resume']) {
      const { stderr, exitCode } = tlda('agent', verb, 'alice', {
        env: scrubAgentEnv(process.env),
      })

      assert.notEqual(exitCode, 0)
      assert.ok(stderr.includes('Usage: tlda agent <list|create|wake|move|set-create-machine|check-ready|attach|hibernate|dismiss|permission|permissions>'))
      assert.ok(!stderr.includes('ECONNREFUSED'))
      assert.ok(!stderr.includes('localhost:99999'))
    }
  })

  it('validates new lifecycle commands without contacting the server when required args are missing', () => {
    for (const verb of ['create', 'wake', 'dismiss']) {
      const { stderr, exitCode } = tlda('agent', verb, {
        env: scrubAgentEnv(process.env),
      })

      assert.notEqual(exitCode, 0)
      assert.ok(stderr.includes(`Usage: tlda agent ${verb}`) || stderr.includes('Usage: tlda agent <create|wake>'))
      assert.ok(!stderr.includes('ECONNREFUSED'))
      assert.ok(!stderr.includes('localhost:99999'))
    }
  })
})

// ---------------------------------------------------------------------------
// Agent permission CLI
// ---------------------------------------------------------------------------

describe('agent permission CLI', () => {
  it('dry-runs friendly names without contacting the server from user context', () => {
    const { stdout, exitCode } = tlda('agent', 'permission', 'alice', 'write', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })

    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('[dry-run] would set alice permission to write (cwd / write / network)'))
    assert.ok(stdout.includes('update metadata.spawnPolicy policy/category'))
  })

  it('uses no-net as a modifier, not a permission type', () => {
    const dryRun = tlda('agent', 'permission', 'alice', 'write', '--no-net', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })
    assert.equal(dryRun.exitCode, 0)
    assert.ok(dryRun.stdout.includes('write (cwd / write / no network)'))

    const asType = tlda('agent', 'permission', 'alice', 'no-net', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })
    assert.notEqual(asType.exitCode, 0)
    assert.ok(asType.stderr.includes('Unknown permission "no-net"'))
  })

  it('shows permission-specific help', () => {
    const { stdout, exitCode } = tlda('agent', 'permission', '--help')

    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('Write scope:'))
    assert.ok(stdout.includes('tlda-write  write configured TLDA project/source roots'))
    assert.ok(stdout.includes('--no-net    rare explicit network-off modifier'))
  })

  it('rejects unknown permissions', () => {
    const { stderr, exitCode } = tlda('agent', 'permission', 'alice', 'workspace-write', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })

    assert.notEqual(exitCode, 0)
    assert.ok(stderr.includes('Unknown permission "workspace-write"'))
    assert.ok(stderr.includes('read, write, tlda-write, full'))
  })

  it('does not expose an escalate alias', () => {
    const { stderr, exitCode } = tlda('agent', 'escalate', 'alice', 'write', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })

    assert.notEqual(exitCode, 0)
    assert.ok(stderr.includes('Usage: tlda agent <list|create|wake|move|set-create-machine|check-ready|attach|hibernate|dismiss|permission|permissions>'))
  })

  it('refuses from an agent context before dry-run escalation', () => {
    const { stderr, exitCode } = tlda('agent', 'permission', 'alice', 'read', '--dry-run', {
      env: { ...scrubAgentEnv(process.env), FLEET_ID: 'fleet:test-agent', FLEET_NAME: 'test-agent' },
    })

    assert.notEqual(exitCode, 0)
    assert.ok(stderr.includes('user/operator-only'))
    assert.ok(stderr.includes('agent context'))
  })

  it('shows set-create-machine help and refuses agent-context dry runs', () => {
    const help = tlda('agent', 'set-create-machine', '--help')
    assert.equal(help.exitCode, 0)
    assert.ok(help.stdout.includes('fleet_prefs.spawn_machine_id'))

    const denied = tlda('agent', 'set-create-machine', 'todd', 'mini', '--dry-run', {
      env: { ...scrubAgentEnv(process.env), FLEET_ID: 'fleet:test-agent', FLEET_NAME: 'test-agent' },
    })
    assert.notEqual(denied.exitCode, 0)
    assert.ok(denied.stderr.includes('user/operator-only'))
  })
})

// ---------------------------------------------------------------------------
// Agent permissions CLI
// ---------------------------------------------------------------------------

describe('agent permissions CLI', () => {
  it('dry-runs default wake behavior without contacting the server', () => {
    const { stdout, exitCode } = tlda('agent', 'permissions', 'alice', 'deploy', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })

    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('[dry-run] would set alice permissions to deploy'))
    assert.ok(stdout.includes('update metadata.requestedPermissions / metadata.spawnPolicy'))
    assert.ok(stdout.includes('run locally: tlda agent wake alice --permissions deploy'))
  })

  it('dry-runs on-wake as metadata-only staging', () => {
    const { stdout, exitCode } = tlda('agent', 'permissions', 'alice', 'app-dev', '--on-wake', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })

    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('[dry-run] would set alice permissions to app-dev'))
    assert.ok(stdout.includes('leave the change for the next wake'))
    assert.ok(!stdout.includes('run locally: tlda agent wake'))
  })

  it('rejects unknown permission profiles', () => {
    const { stderr, exitCode } = tlda('agent', 'permissions', 'alice', 'launch-the-moon', '--dry-run', {
      env: scrubAgentEnv(process.env),
    })

    assert.notEqual(exitCode, 0)
    assert.ok(stderr.includes('Unknown permission profile "launch-the-moon"'))
    assert.ok(stderr.includes('app-dev'))
    assert.ok(stderr.includes('deploy'))
  })

  it('refuses from an agent context before dry-run permission changes', () => {
    const { stderr, exitCode } = tlda('agent', 'permissions', 'alice', 'deploy', '--dry-run', {
      env: { ...scrubAgentEnv(process.env), FLEET_ID: 'fleet:test-agent', FLEET_NAME: 'test-agent' },
    })

    assert.notEqual(exitCode, 0)
    assert.ok(stderr.includes('user/operator-only'))
    assert.ok(stderr.includes('agent context'))
  })
})

// ---------------------------------------------------------------------------
// Source file collection
// ---------------------------------------------------------------------------

describe('source files', () => {
  let dir

  it('collects tex, bib, sty, svg files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tlda-test-src-'))
    writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}')
    writeFileSync(join(dir, 'refs.bib'), '@article{foo}')
    writeFileSync(join(dir, 'custom.sty'), '\\ProvidesPackage{custom}')
    writeFileSync(join(dir, 'fig.svg'), '<svg/>')
    writeFileSync(join(dir, 'notes.txt'), 'not a source file')
    writeFileSync(join(dir, 'data.csv'), '1,2,3')

    const { collectSourceFiles } = await import('../cli/lib/source-files.mjs')
    const files = collectSourceFiles(dir)
    const paths = files.map(f => f.path).sort()

    assert.deepEqual(paths, ['custom.sty', 'fig.svg', 'main.tex', 'refs.bib'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('recurses into subdirectories', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tlda-test-src-'))
    mkdirSync(join(dir, 'sections'))
    mkdirSync(join(dir, 'figs'))
    writeFileSync(join(dir, 'main.tex'), '\\documentclass{article}')
    writeFileSync(join(dir, 'sections', 'intro.tex'), '\\section{Intro}')
    writeFileSync(join(dir, 'figs', 'plot.svg'), '<svg/>')

    const { collectSourceFiles } = await import('../cli/lib/source-files.mjs')
    const files = collectSourceFiles(dir)
    const paths = files.map(f => f.path).sort()

    assert.deepEqual(paths, ['figs/plot.svg', 'main.tex', 'sections/intro.tex'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips hidden dirs and node_modules', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tlda-test-src-'))
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'main.tex'), 'hello')
    writeFileSync(join(dir, '.git', 'config.tex'), 'hidden')
    writeFileSync(join(dir, 'node_modules', 'pkg.tex'), 'pkg')

    const { collectSourceFiles } = await import('../cli/lib/source-files.mjs')
    const files = collectSourceFiles(dir)

    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'main.tex')
    rmSync(dir, { recursive: true, force: true })
  })

  it('encodes binary files as base64', async () => {
    dir = mkdtempSync(join(tmpdir(), 'tlda-test-src-'))
    writeFileSync(join(dir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const { collectSourceFiles } = await import('../cli/lib/source-files.mjs')
    const files = collectSourceFiles(dir)

    assert.equal(files.length, 1)
    assert.equal(files[0].encoding, 'base64')
    assert.equal(Buffer.from(files[0].content, 'base64').length, 4)
    rmSync(dir, { recursive: true, force: true })
  })

  it('junk patterns are detected', async () => {
    const { isJunk } = await import('../cli/lib/source-files.mjs')
    assert.ok(isJunk('main.aux'))
    assert.ok(isJunk('main.log'))
    assert.ok(isJunk('main.fdb_latexmk'))
    assert.ok(isJunk('main.synctex.gz'))
    assert.ok(!isJunk('main.tex'))
    assert.ok(!isJunk('fig.svg'))
  })
})

// ---------------------------------------------------------------------------
// Hash-based diffing
// ---------------------------------------------------------------------------

describe('source hashes', () => {
  it('produces consistent hashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlda-test-hash-'))
    writeFileSync(join(dir, 'a.tex'), 'hello world')
    writeFileSync(join(dir, 'b.tex'), 'hello world')
    writeFileSync(join(dir, 'c.tex'), 'different')

    const { collectSourceHashes } = await import('../cli/lib/source-files.mjs')
    const hashes = collectSourceHashes(dir)

    assert.equal(Object.keys(hashes).length, 3)
    assert.equal(hashes['a.tex'], hashes['b.tex'], 'identical files should have same hash')
    assert.notEqual(hashes['a.tex'], hashes['c.tex'], 'different files should have different hash')

    // Hash should be a 32-char hex string (MD5)
    assert.match(hashes['a.tex'], /^[0-9a-f]{32}$/)

    rmSync(dir, { recursive: true, force: true })
  })

  it('collectSpecificFiles reads only requested files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlda-test-specific-'))
    writeFileSync(join(dir, 'a.tex'), 'aaa')
    writeFileSync(join(dir, 'b.tex'), 'bbb')
    writeFileSync(join(dir, 'c.tex'), 'ccc')

    const { collectSpecificFiles } = await import('../cli/lib/source-files.mjs')
    const files = collectSpecificFiles(dir, ['a.tex', 'c.tex'])

    assert.equal(files.length, 2)
    assert.deepEqual(files.map(f => f.path).sort(), ['a.tex', 'c.tex'])
    assert.equal(files.find(f => f.path === 'a.tex').content, 'aaa')

    rmSync(dir, { recursive: true, force: true })
  })

  it('collectSpecificFiles skips missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlda-test-specific-'))
    writeFileSync(join(dir, 'a.tex'), 'aaa')

    const { collectSpecificFiles } = await import('../cli/lib/source-files.mjs')
    const files = collectSpecificFiles(dir, ['a.tex', 'nonexistent.tex'])

    assert.equal(files.length, 1)
    assert.equal(files[0].path, 'a.tex')

    rmSync(dir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Shadow mirror refs
// ---------------------------------------------------------------------------

describe('shadow mirror refs', () => {
  function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  }

  it('initializes a fresh shadow repo before installing the blocking commit hook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-shadow-init-test-'))

    try {
      const { initProjectStore, projectDir } = await import('../server/lib/project-store.mjs')
      const { initShadowRepo } = await import('../server/lib/shadow-repo.mjs')

      initProjectStore(root)
      mkdirSync(projectDir('fresh-shadow'), { recursive: true })

      const repo = await initShadowRepo('fresh-shadow')
      assert.equal(git(repo, ['log', '--format=%s', '-1']), 'init')

      appendFileSync(join(repo, 'CLAUDE.md'), '\nmanual change\n')
      git(repo, ['add', 'CLAUDE.md'])
      assert.throws(
        () => git(repo, ['commit', '-m', 'manual edit']),
        /Direct commits to this shadow repo are blocked/,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('imports a shadow bundle as refs without moving the checked-out branch', () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-mirror-test-'))
    const shadow = join(root, 'shadow')
    const source = join(root, 'source')
    mkdirSync(shadow)
    mkdirSync(source)

    try {
      git(shadow, ['init'])
      git(shadow, ['config', 'user.email', 'tlda@test'])
      git(shadow, ['config', 'user.name', 'tlda'])
      writeFileSync(join(shadow, 'main.tex'), 'one\n')
      git(shadow, ['add', 'main.tex'])
      git(shadow, ['commit', '-m', 'Build at test'])
      const hash = git(shadow, ['rev-parse', 'HEAD'])
      const hash7 = hash.slice(0, 7)
      const bundle = join(root, 'shadow.bundle')
      git(shadow, ['bundle', 'create', bundle, '--all'])

      git(source, ['init'])
      git(source, ['config', 'user.email', 'user@test'])
      git(source, ['config', 'user.name', 'user'])
      writeFileSync(join(source, 'notes.txt'), 'working tree stays here\n')
      git(source, ['add', 'notes.txt'])
      git(source, ['commit', '-m', 'source root'])
      const beforeHead = git(source, ['rev-parse', 'HEAD'])

      git(source, ['bundle', 'verify', bundle])
      git(source, ['fetch', bundle, `+${hash}:refs/tags/shadow/${hash7}`])
      git(source, ['cat-file', '-e', `${hash}^{commit}`])
      git(source, ['update-ref', 'refs/tlda/shadow/HEAD', hash])

      assert.equal(git(source, ['rev-parse', `shadow/${hash7}`]), hash)
      assert.equal(git(source, ['rev-parse', 'refs/tlda/shadow/HEAD']), hash)
      assert.equal(git(source, ['rev-parse', 'HEAD']), beforeHead)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
