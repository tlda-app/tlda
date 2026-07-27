// A shadow commit IS the record of a built state. If it records fewer files
// than the build declared part of the paper, the version is wrong and nothing
// says so — the loss only surfaces when someone restores from it, months later.
// Silent and catastrophic, history lost: the bar AGENTS.md sets for a test.
//
// The assertion is recorded-vs-corrupted, not "the function returned a value":
// the commit's tracked file set equals the paper scope, minus the intermediates
// listed in NOT_VERSIONED below — same names, same bytes — and one edit moves
// exactly one file.
//
// Run: node --test tests/shadow-snapshot-records-scope.test.mjs

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import { initProjectStore, sourceDir, outputDir, projectDir } from '../server/lib/project-store.mjs'
import { commitSnapshot } from '../server/lib/shadow-repo.mjs'

const PROJECT = 'scope-fidelity-fixture'

// Files the shadow repo keeps for its own bookkeeping. Not paper content, and
// not expected to appear in the paper scope.
const BOOKKEEPING = new Set(['.gitignore', 'CLAUDE.md'])

/**
 * Paper-scope entries that are deliberately NOT versioned, because the build
 * rewrites them into a form that is. This list is the whole exclusion — it is
 * written out here rather than read from the shadow's .gitignore on purpose,
 * so that it is visible and arguable, and so the test cannot excuse a file it
 * simply failed to record. Anything not on this list must be in the commit.
 *
 * pdf figures: Skip, 2026-07-26 — "We don't use PDF figures." / "The PDF thing
 * is fake. We rewrite the actual things to SVGs, and we use SVGs." The .pdf is
 * a generated intermediate; the .svg sibling carries the record. So dropping
 * the .pdf is correct — but only while the .svg is actually there, which is
 * what `recordedAs` below checks. A pdf dropped with no svg beside it is a
 * figure lost from that version.
 */
const NOT_VERSIONED = [
  {
    what: 'pdf figure intermediate (the build rewrites it to svg)',
    match: (rel) => rel.endsWith('.pdf'),
    recordedAs: (rel) => rel.replace(/\.pdf$/, '.svg'),
  },
]

function intermediateRuleFor(rel) {
  return NOT_VERSIONED.find((rule) => rule.match(rel)) || null
}

function git(repoDir, args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
}

/**
 * Stand up a project whose source tree is `files` ({ relPath: string|Buffer })
 * and whose paper scope — what the build declared the paper to be — is exactly
 * those paths. relevant-files.json is the real interface here: build-runner
 * writes it at the end of every successful build, readPaperScope reads it.
 */
function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-shadow-scope-'))
  initProjectStore(root)
  const srcDir = sourceDir(PROJECT)
  const outDir = outputDir(PROJECT)
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  for (const [rel, content] of Object.entries(files)) {
    const path = join(srcDir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }

  writeFileSync(
    join(outDir, 'relevant-files.json'),
    JSON.stringify({ files: Object.keys(files).map((rel) => join(srcDir, rel)).sort() }, null, 2),
  )

  return { root, srcDir, repoDir: join(projectDir(PROJECT), 'shadow-repo') }
}

/** Paper files tracked at HEAD, excluding the shadow's own bookkeeping. */
function recordedFiles(repoDir) {
  return git(repoDir, ['ls-tree', '-r', '--name-only', 'HEAD'])
    .split('\n')
    .filter((line) => line && !BOOKKEEPING.has(line))
    .sort()
}

function recordedBytes(repoDir, rel) {
  return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 })
}

/**
 * The whole point. Every file the build called part of the paper is in the
 * commit byte for byte, except the declared intermediates — and each of those
 * is excused only because the thing it was rewritten into IS in the commit.
 */
function assertRecordsScope({ repoDir, srcDir }, scope) {
  const recorded = recordedFiles(repoDir)
  const expected = [...scope].filter((rel) => !intermediateRuleFor(rel)).sort()

  const missing = expected.filter((f) => !recorded.includes(f))
  assert.deepEqual(
    missing,
    [],
    `paper scope declared ${expected.length} file(s) that must be versioned; the version ` +
      `records ${recorded.length}. Not recorded: ${missing.join(', ')}. These are lost from ` +
      `this version, and nothing reports it. If one of them is a new kind of build ` +
      `intermediate, say so in NOT_VERSIONED — do not delete this assertion.`,
  )
  assert.deepEqual(recorded, expected, 'the version records files the paper scope did not declare')

  for (const rel of expected) {
    assert.deepEqual(
      recordedBytes(repoDir, rel),
      readFileSync(join(srcDir, rel)),
      `${rel} is recorded, but its recorded bytes differ from the source that was built`,
    )
  }

  // An intermediate may be dropped only because its rewritten form is recorded.
  // Drop both and the figure is gone from this version with nothing to say so.
  for (const rel of scope) {
    const rule = intermediateRuleFor(rel)
    if (!rule) continue
    const counterpart = rule.recordedAs(rel)
    assert.ok(
      recorded.includes(counterpart),
      `${rel} was left out of the version as a ${rule.what}, but ${counterpart} — the form ` +
        `that is supposed to carry the record — is not in the commit either. The figure is ` +
        `lost from this version.`,
    )
  }
}

test('a version records every file the build declared part of the paper', async (t) => {
  const files = {
    'main.tex': '\\documentclass{article}\n\\begin{document}\\input{sec}\\end{document}\n',
    'sec.tex': '\\section{One}\nAlpha.\n',
    'refs.bib': '@article{a, title={A}}\n',
    'preamble/macros.tex': '\\newcommand{\\x}{x}\n',
  }
  const proj = makeProject(files)
  t.after(() => rmSync(proj.root, { recursive: true, force: true }))

  const result = await commitSnapshot(PROJECT)
  assert.ok(result?.hash, 'the first build recorded no version at all')

  assertRecordsScope(proj, Object.keys(files))
})

test('a figure survives in the version as the svg the build rewrote it to', async (t) => {
  // The .pdf is a generated intermediate and is expected to be absent. What
  // must be there is the .svg beside it — that is the figure's record.
  const files = {
    'main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n' +
      '\\begin{document}\\includegraphics{figures/plot}\\end{document}\n',
    'figures/plot.pdf': Buffer.from('%PDF-1.4\n% generated intermediate\n%%EOF\n'),
    'figures/plot.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n',
  }
  const proj = makeProject(files)
  t.after(() => rmSync(proj.root, { recursive: true, force: true }))

  const result = await commitSnapshot(PROJECT)
  assert.ok(result?.hash, 'the first build recorded no version at all')

  assertRecordsScope(proj, Object.keys(files))
  assert.ok(
    recordedFiles(proj.repoDir).includes('figures/plot.svg'),
    'the svg that carries the figure is not in the version',
  )
})

test('a figure whose svg is missing is not silently written off as an intermediate', async (t) => {
  // The exclusion is not a blanket permission to drop figures. With no svg
  // beside it, the pdf is the only record there is, and losing it loses the
  // figure. This is the case the exclusion must not be allowed to hide.
  const files = {
    'main.tex': '\\documentclass{article}\n\\usepackage{graphicx}\n' +
      '\\begin{document}\\includegraphics{figures/orphan}\\end{document}\n',
    'figures/orphan.pdf': Buffer.from('%PDF-1.4\n% no svg sibling\n%%EOF\n'),
  }
  const proj = makeProject(files)
  t.after(() => rmSync(proj.root, { recursive: true, force: true }))

  await commitSnapshot(PROJECT)

  assert.throws(
    () => assertRecordsScope(proj, Object.keys(files)),
    /lost from this version/,
    'a pdf with no svg sibling was accepted as a versioned figure — the exclusion is too broad',
  )
})

test('one edit moves exactly one file; every other file is byte-identical', async (t) => {
  const files = {
    'main.tex': '\\documentclass{article}\n\\begin{document}\\input{sec}\\end{document}\n',
    'sec.tex': '\\section{One}\nAlpha.\n',
    'refs.bib': '@article{a, title={A}}\n',
  }
  const proj = makeProject(files)
  t.after(() => rmSync(proj.root, { recursive: true, force: true }))

  const first = await commitSnapshot(PROJECT)
  assert.ok(first?.hash, 'the first build recorded no version at all')

  writeFileSync(join(proj.srcDir, 'sec.tex'), '\\section{One}\nBeta.\n')
  const second = await commitSnapshot(PROJECT)
  assert.ok(second?.hash, 'the rebuild after an edit recorded no version')
  assert.notEqual(second.hash, first.hash, 'the edit was folded into the previous version')

  const changed = git(proj.repoDir, ['diff', '--name-only', first.hash, second.hash])
    .split('\n').filter(Boolean).sort()
  assert.deepEqual(changed, ['sec.tex'], 'the version records changes to files that were not edited')

  // The earlier state is still recoverable, and is what was actually built then.
  assert.match(
    execFileSync('git', ['show', `${first.hash}:sec.tex`], { cwd: proj.repoDir, encoding: 'utf8' }),
    /Alpha\./,
    'the earlier state is no longer recoverable from its own version',
  )
  assertRecordsScope(proj, Object.keys(files))
})
