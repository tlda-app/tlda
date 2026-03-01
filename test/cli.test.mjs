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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(__dirname, '..')
const CTD = join(ROOT, 'cli', 'tlda.mjs')

// Helper: run tlda with args, return { stdout, stderr, exitCode }
function tlda(...args) {
  try {
    const stdout = execFileSync('node', [CTD, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, TLDA_SERVER: 'http://localhost:99999' }, // unreachable server
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
    assert.ok(stdout.includes('tlda — Claude TLDraw CLI'))
    assert.ok(stdout.includes('Commands:'))
  })

  it('shows per-command help', () => {
    for (const cmd of ['create', 'push', 'watch', 'open', 'status', 'errors', 'build', 'delete', 'preview', 'server', 'config']) {
      const { stdout, exitCode } = tlda(cmd, '--help')
      assert.equal(exitCode, 0, `${cmd} --help should exit 0`)
      assert.ok(stdout.includes('tlda'), `${cmd} --help should show usage`)
    }
  })

  it('completions outputs zsh script', () => {
    const { stdout, exitCode } = tlda('completions')
    assert.equal(exitCode, 0)
    assert.ok(stdout.includes('#compdef tlda'))
    assert.ok(stdout.includes('_ctd'))
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
