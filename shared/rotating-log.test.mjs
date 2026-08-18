import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createRotatingAppender, rotateBeforeOpen, rotateNow } from './rotating-log.mjs'

// Nothing in this project rotated a log until 2026-08-18, when `client.log`
// reached 955 MB and `fleet-daemon.testing.log` 342 MB on the machine Skip
// works on, while the volume hit 100% with 179 MiB free.
//
// The rule these tests enforce is rotation, never truncation. `client.log` is
// the instrument several of that night's findings were measured from, so a
// mechanism that resets the file on a size threshold would have destroyed the
// evidence of whatever made it large.

function dir(t) {
  const d = mkdtempSync(join(tmpdir(), 'rotlog-'))
  t.after(() => rmSync(d, { recursive: true, force: true }))
  return d
}

test('rotation moves the bytes aside instead of truncating in place', async (t) => {
  const d = dir(t)
  const f = join(d, 'client.log')
  // Big enough to hold everything written here, so `keep` never discards and
  // the only thing under test is whether rotation loses bytes.
  const append = createRotatingAppender(f, { maxBytes: 200, keep: 50, checkEveryMs: 0 })

  for (let i = 0; i < 40; i++) await append(`line ${i} ${'x'.repeat(20)}\n`)

  const generations = fs.readdirSync(d).sort()
  assert.ok(generations.includes('client.log'), 'the current file exists')
  assert.ok(generations.includes('client.log.1'), 'and a previous generation was kept')

  // Truncation would lose the early lines — exactly the ones a post-incident
  // read needs, since they are what led up to whatever made the file large.
  const all = generations.map(g => fs.readFileSync(join(d, g), 'utf8')).join('')
  for (const i of [0, 1, 20, 39]) {
    assert.ok(all.includes(`line ${i} `), `line ${i} survived rotation`)
  }
})

test('keep bounds the generations, and that is what discards old bytes', async (t) => {
  const d = dir(t)
  const f = join(d, 'bounded.log')
  const append = createRotatingAppender(f, { maxBytes: 100, keep: 2, checkEveryMs: 0 })
  for (let i = 0; i < 40; i++) await append(`line ${i} ${'x'.repeat(20)}\n`)

  const generations = fs.readdirSync(d).sort()
  assert.deepEqual(generations, ['bounded.log', 'bounded.log.1', 'bounded.log.2'],
    'never more than keep generations, however long it runs')
  const all = generations.map(g => fs.readFileSync(join(d, g), 'utf8')).join('')
  assert.ok(all.includes('line 39 '), 'the recent end is what is retained')
  assert.ok(!all.includes('line 0 '),
    'and the oldest is gone — bounded retention discards, which is the trade being made')
})

test('generations shift oldest-first and the count is bounded', (t) => {
  const d = dir(t)
  const f = join(d, 'a.log')
  for (const [name, body] of [['a.log', 'newest'], ['a.log.1', 'older'], ['a.log.2', 'oldest']]) {
    fs.writeFileSync(join(d, name), body)
  }
  rotateNow(f, { keep: 3 })

  assert.equal(fs.readFileSync(join(d, 'a.log.1'), 'utf8'), 'newest')
  assert.equal(fs.readFileSync(join(d, 'a.log.2'), 'utf8'), 'older')
  assert.equal(fs.readFileSync(join(d, 'a.log.3'), 'utf8'), 'oldest')
  assert.ok(!fs.existsSync(f), 'the current file is moved aside, not copied')
  // Shifting newest-first would have overwritten .2 with .1 before .2 moved,
  // leaving one generation holding two different logs' worth of lines.
  assert.ok(!fs.existsSync(join(d, 'a.log.4')), 'keep is respected')
})

test('a file under the threshold is left alone', (t) => {
  const d = dir(t)
  const f = join(d, 'small.log')
  fs.writeFileSync(f, 'not big enough\n')
  assert.equal(rotateBeforeOpen(f, { maxBytes: 1024 }), false)
  assert.ok(fs.existsSync(f) && !fs.existsSync(`${f}.1`), 'nothing moved')
})

// The trap that makes naive rotation of the daemon log worse than none.
//
// launchd owns that descriptor through StandardOutPath. Renaming the file under
// a running writer does not redirect it: the writer keeps filling the renamed
// inode while the path it was rotated to stays empty. That reads as successful
// rotation and leaves the CURRENT log blank, which is why rotateBeforeOpen
// exists and why it is only ever called before the process starts.
test('renaming under a held descriptor does not redirect the writer', (t) => {
  const d = dir(t)
  const f = join(d, 'held.log')
  const fd = fs.openSync(f, 'a')
  fs.writeSync(fd, 'before rotation\n')

  rotateNow(f, { keep: 2 })
  fs.writeSync(fd, 'after rotation\n')
  fs.closeSync(fd)

  const rotated = fs.readFileSync(`${f}.1`, 'utf8')
  assert.ok(rotated.includes('after rotation'),
    'the held descriptor keeps writing to the renamed inode — this is the trap')
  assert.ok(!fs.existsSync(f),
    'and nothing recreates the original path, so the "current" log would be absent')
})

test('rotateBeforeOpen is safe at the point the writer is not running', (t) => {
  const d = dir(t)
  const f = join(d, 'daemon.log')
  fs.writeFileSync(f, 'x'.repeat(500))

  // The restart sequence: rotate, then the writer opens the path afresh.
  assert.equal(rotateBeforeOpen(f, { maxBytes: 100, keep: 2 }), true)
  const fd = fs.openSync(f, 'a')
  fs.writeSync(fd, 'new generation\n')
  fs.closeSync(fd)

  assert.equal(fs.readFileSync(f, 'utf8'), 'new generation\n', 'the current log is the live one')
  assert.equal(fs.readFileSync(`${f}.1`, 'utf8').length, 500, 'and the old bytes are kept')
})

test('the size check is throttled rather than run per-append', async (t) => {
  const d = dir(t)
  const f = join(d, 'throttled.log')
  let clock = 0
  // Asserted through observable behaviour rather than by counting `stat` calls:
  // the module holds a namespace import, and a monkeypatch on `fs.promises`
  // does not necessarily reach it. What the throttle MEANS is that a file over
  // the threshold is not rotated until the interval has passed.
  const append = createRotatingAppender(f, { maxBytes: 50, keep: 3, checkEveryMs: 10_000, now: () => clock })

  await append('x'.repeat(400) + '\n')   // first append: checks, file was absent
  for (let i = 0; i < 20; i++) await append('more\n')
  assert.ok(!fs.existsSync(`${f}.1`),
    'well over the threshold, but inside the interval, so no rotation yet')

  clock = 60_000
  await append('after the interval\n')
  assert.ok(fs.existsSync(`${f}.1`), 'once the interval passes the check runs and it rotates')
})
