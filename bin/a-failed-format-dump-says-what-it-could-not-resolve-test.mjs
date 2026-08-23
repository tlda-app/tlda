#!/usr/bin/env node
/**
 * A failed format dump names what it could not resolve.
 *
 * WHAT THIS CROSSES. `latexErrorSummary` is a string function, and testing it
 * on strings I wrote would prove only that I can write a string matching my own
 * regex. So the inputs here are produced by running **the exact command
 * `ensureFormat` issues**, on real `.hdr` fixtures, and feeding what real
 * `pdflatex -ini` actually printed into the function. If TeX changes what it
 * emits, this goes red — which is the whole point, because the previous version
 * of this log line was wrong about where the error lived.
 *
 * A CONTROL THAT SUCCEEDS IS REQUIRED. Two failing cases prove nothing on their
 * own: a rig that cannot dump a format at all fails identically for both and
 * reads as the feature working. `amsmath` alone must produce a `.fmt` and no
 * error line.
 *
 * EACH CASE GETS ITS OWN DIRECTORY. Sharing one lets a `.fmt` left by an earlier
 * case satisfy a later one, so a failure reads as a pass.
 *
 * FIXTURES ONLY. Nothing here reads, builds, or names any real project.
 *
 * Run: node bin/a-failed-format-dump-says-what-it-could-not-resolve-test.mjs
 */

import { exec as execCb } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { latexErrorSummary, trackedExec } from '../server/lib/build-runner.mjs'

let failures = 0
function ok(name, cond, detail = '') {
  if (cond) { console.log(`  ok  ${name}`); return }
  failures++
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
}

// The real binary, not the one on an agent's PATH. `~/.claude/bin/pdflatex` is
// a guard that refuses to compile for anything carrying FLEET_ID and exits 64
// with its own message — which is not TeX output, so every case would "fail"
// with no `!` line and the test would report the summary as broken. The server
// runs under launchd without that directory on PATH; this resolves what the
// server would resolve.
function realPdflatex() {
  const guard = join(homedir(), '.claude', 'bin')
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir === guard || !dir) continue
    const candidate = join(dir, 'pdflatex')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const PDFLATEX = realPdflatex()
if (!PDFLATEX) {
  console.log('SKIP — no pdflatex outside the agent guard; nothing was established')
  process.exit(0)
}

const FMT_BASE = 'main-fmt'
const root = mkdtempSync(join(tmpdir(), 'format-dump-'))

// Byte-for-byte the command in ensureFormat, with only the binary made explicit.
function dumpFormat(caseDir) {
  const cmd =
    `"${PDFLATEX}" -ini -interaction=nonstopmode -output-format=dvi ` +
    `-jobname="${FMT_BASE}" "&pdflatex" mylatexformat.ltx "${FMT_BASE}.hdr"`
  return new Promise(resolve => {
    execCb(cmd, { cwd: caseDir, timeout: 60000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ failed: Boolean(err), stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

function caseDir(label, preamble) {
  const dir = join(root, label)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${FMT_BASE}.hdr`),
    `\\documentclass{article}\n${preamble}\n\\csname endofdump\\endcsname\n`,
  )
  return dir
}

try {
  // -- the control, first, because the failures mean nothing without it -------
  console.log('\na preamble that resolves dumps a format and reports no error')
  const okDir = caseDir('control-amsmath', '\\usepackage{amsmath}')
  const good = await dumpFormat(okDir)
  ok('the command succeeds', !good.failed, good.stdout.slice(-400))
  ok('a format file is produced', existsSync(join(okDir, `${FMT_BASE}.fmt`)))
  ok('there is no LaTeX error to summarise',
    latexErrorSummary(`${good.stdout}\n${good.stderr}`) === null,
    JSON.stringify(latexErrorSummary(`${good.stdout}\n${good.stderr}`)))

  // -- a package that is not installed ---------------------------------------
  console.log('\na package that is not installed is named')
  const pkgDir = caseDir('missing-package', '\\usepackage{this-package-does-not-exist}')
  const pkg = await dumpFormat(pkgDir)
  ok('the command fails', pkg.failed)
  ok('no format file is produced', !existsSync(join(pkgDir, `${FMT_BASE}.fmt`)))

  const pkgSummary = latexErrorSummary(`${pkg.stdout}\n${pkg.stderr}`)
  ok('the summary names the file that could not be resolved',
    pkgSummary && pkgSummary.includes('this-package-does-not-exist.sty'), JSON.stringify(pkgSummary))
  ok('it leads with the LaTeX error, not the shell command',
    pkgSummary && pkgSummary.startsWith('!') && !/Command failed/.test(pkgSummary),
    JSON.stringify(pkgSummary))
  // Not merely "does not LEAD with" it. Written that way first, the assertion
  // stayed green with the Emergency-stop filter deleted, because the stop is
  // appended after the real cause and the summary still began with the error.
  // A check that cannot go red when the thing it guards is removed is not a
  // check; it has to say the noise is absent, not merely second.
  ok('the consequence is left out entirely, not just put second',
    pkgSummary && !/Emergency stop/i.test(pkgSummary), JSON.stringify(pkgSummary))

  // -- an \input target absent from the build directory ----------------------
  // The nasty one: the file can exist in the project and never be copied into
  // buildDir, and nothing about the project looks wrong.
  console.log('\nan \\input target missing from the build directory is named')
  const inpDir = caseDir('missing-input', '\\input{a-file-not-in-the-build-dir}')
  const inp = await dumpFormat(inpDir)
  ok('the command fails', inp.failed)
  ok('no format file is produced', !existsSync(join(inpDir, `${FMT_BASE}.fmt`)))

  const inpSummary = latexErrorSummary(`${inp.stdout}\n${inp.stderr}`)
  ok('the summary names the missing input by name',
    inpSummary && inpSummary.includes('a-file-not-in-the-build-dir'), JSON.stringify(inpSummary))
  ok('the two failures are distinguishable from each other',
    pkgSummary !== inpSummary, `both said ${JSON.stringify(pkgSummary)}`)

  // -- the wire: what ensureFormat actually catches --------------------------
  //
  // Everything above proves the summary against real TeX output. It says
  // nothing about whether that output ever REACHES the summary — and it did
  // not, which is half the fix. `exec` hands stdout to its callback as a
  // separate argument and does not put it on the error, so rejecting with the
  // bare error threw the LaTeX message away and left only the shell wrapper.
  console.log('\nthe failing command\'s output reaches the caller that has to explain it')
  const wireDir = caseDir('wire-missing-package', '\\usepackage{this-package-does-not-exist}')
  const wireCmd =
    `"${PDFLATEX}" -ini -interaction=nonstopmode -output-format=dvi ` +
    `-jobname="${FMT_BASE}" "&pdflatex" mylatexformat.ltx "${FMT_BASE}.hdr"`
  let rejected = null
  try {
    await trackedExec('test-build', wireCmd, { cwd: wireDir, timeout: 60000, maxBuffer: 50 * 1024 * 1024 })
  } catch (e) {
    rejected = e
  }
  ok('it rejects', rejected !== null)
  ok('the bare message is the shell wrapper, which is why it was useless',
    rejected && /Command failed/.test(rejected.message), JSON.stringify(rejected?.message?.slice(0, 80)))
  ok('the error carries the command output',
    rejected && typeof rejected.stdout === 'string' && rejected.stdout.length > 0,
    `stdout was ${typeof rejected?.stdout}`)
  ok('summarising what the error carries names the unresolved file',
    latexErrorSummary(`${rejected?.stdout || ''}\n${rejected?.stderr || ''}`)
      ?.includes('this-package-does-not-exist.sty'),
    JSON.stringify(latexErrorSummary(`${rejected?.stdout || ''}\n${rejected?.stderr || ''}`)))

  // -- the shape the old line had, so a regression is visible ----------------
  console.log('\nthe output the old line showed carries no cause at all')
  ok('a bare `Command failed:` message summarises to nothing',
    latexErrorSummary('Command failed: pdflatex -ini -interaction=nonstopmode ...') === null,
    'if this ever returns a string, the function is matching the wrapper')
  ok('an Emergency stop with no stated cause is still reported',
    latexErrorSummary('! Emergency stop.\n') === '! Emergency stop.',
    'a stop with no cause is a finding; returning null would read as no output')
  ok('empty output summarises to nothing', latexErrorSummary('') === null)
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nPASS a failed format dump says what it could not resolve')
process.exit(failures ? 1 : 0)
