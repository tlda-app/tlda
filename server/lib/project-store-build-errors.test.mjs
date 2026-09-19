import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  extractBuildErrors,
  initProjectStore,
  setProjectPathOverride,
} from './project-store.mjs'

test('private build error extraction cannot read the stale live project log or source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-private-build-errors-'))
  const instance = join(root, 'private-instance', 'paper')
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('paper')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'paper', mainFile: 'main.tex' })
  writeFileSync(join(root, 'paper', 'latex.log'), '! Stale live error.\nl.1 live\n')
  writeFileSync(join(root, 'paper', 'source', 'main.tex'), 'live source\n')

  mkdirSync(join(instance, 'source'), { recursive: true })
  writeFileSync(join(instance, 'latex.log'), 'Clean private build.\n')
  writeFileSync(join(instance, 'source', 'main.tex'), 'private source\n')
  setProjectPathOverride('paper', instance)

  // logMissing false: this build HAS a log and it is clean. That is a different
  // answer from the one below, and telling them apart is the point of the field.
  assert.deepEqual(await extractBuildErrors('paper'), { errors: [], warnings: [], logMissing: false })
})

test('an absent log is reported as absent, not as a clean build', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-missing-build-log-'))
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('paper')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'paper', mainFile: 'main.tex' })
  // No latex.log written at all — a failed build whose log never reached the
  // live project. Before `logMissing` this returned exactly what a clean build
  // returns, which is how `tlda project errors` answered `Clean.` about a build
  // the server was reporting as `error`.
  const result = await extractBuildErrors('paper')
  assert.deepEqual(result, { errors: [], warnings: [], logMissing: true })

  // The counterfactual that makes the assertion above mean something: the same
  // call against a log that IS there must come back logMissing false, or the
  // field would be reporting "missing" for everything and the test would pass
  // without measuring anything.
  writeFileSync(join(root, 'paper', 'latex.log'), '! Undefined control sequence.\nl.5 \\undefinedcommand\n')
  const withLog = await extractBuildErrors('paper')
  assert.equal(withLog.logMissing, false)
  assert.equal(withLog.errors.length, 1)
})

// The reason a render failed arrives on the lines AFTER the marker.
// `childFailureDetail` writes "<how it ended>. Its last output was:\n<output>"
// through one addLog call, so only its first line carries `[build] `. This is
// the production log of `submission-week1-homework-qtm285:skipper`, whose
// entire reported error was the sentence promising the output — the line naming
// the missing filter was parsed away, and the student's work looked like it had
// failed for no stated reason.
test('a build error keeps the output its first line promises', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-log-continuation-'))
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('homework')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'homework', mainFile: 'week1-homework.qmd' })
  writeFileSync(join(root, 'homework', 'build.log'), [
    '[qmd] homework: quarto render week1-homework.qmd',
    '[build] quarto render failed for week1-homework.qmd: exited with status 1. Its last output was:',
    'ERROR: cannot open homework-calibration.qmd.support/answer-placement-warning.lua',
    'Execution halted',
    '[qmd] homework: publishing diagnostics',
  ].join('\n') + '\n')

  const { errors, logMissing } = await extractBuildErrors('homework')
  assert.equal(logMissing, false)
  assert.equal(errors.length, 1, 'the later [qmd] line must not become a second error')
  // The whole point: the cause survives the parse.
  assert.match(errors[0].message, /answer-placement-warning\.lua/)
  assert.match(errors[0].message, /Execution halted/)
  // And the marked line that follows is NOT swallowed into it.
  assert.doesNotMatch(errors[0].message, /publishing diagnostics/)
})

test('an unmarked line before any build error is not an error', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-log-preamble-'))
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('homework')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'homework', mainFile: 'week1-homework.qmd' })
  writeFileSync(join(root, 'homework', 'build.log'), 'starting up\nnothing marked here\n')

  assert.deepEqual(await extractBuildErrors('homework'), { errors: [], warnings: [], logMissing: false })
})

// The cause is at the END of what a renderer managed to say, under whatever
// progress chatter it printed first. Quarto lists every chunk it knits — the
// real submission printed 33 of them, two lines each — so a cap that keeps the
// FIRST n lines reports the knitting and drops the pandoc error underneath it.
// Observed in production after the first version of this parser shipped: the
// message ran to `pandoc / to: html` and stopped, one line short of the reason.
test('a long build error keeps its end, where the reason is', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-log-tail-'))
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('homework')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'homework', mainFile: 'week1-homework.qmd' })
  const chatter = Array.from({ length: 66 }, (_, i) => `${i + 1}/33 [unnamed-chunk-${i}]`)
  writeFileSync(join(root, 'homework', 'build.log'), [
    '[build] quarto render failed for week1-homework.qmd: exited with status 1. Its last output was:',
    ...chatter,
    'ERROR: cannot open homework-calibration.qmd.support/answer-placement-warning.lua',
    'Execution halted',
  ].join('\n') + '\n')

  const { errors } = await extractBuildErrors('homework')
  assert.equal(errors.length, 1)
  // The reason survives, which is the entire point.
  assert.match(errors[0].message, /answer-placement-warning\.lua/)
  assert.match(errors[0].message, /Execution halted/)
  // The headline is kept even though the chatter between it and the end is not.
  assert.match(errors[0].message, /quarto render failed for week1-homework\.qmd/)
  // And the message stays bounded rather than carrying all 66 progress lines.
  assert.ok(errors[0].message.split('\n').length <= 42, errors[0].message.split('\n').length)
})
