import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { publishDeckIntoBook, renderDeckSet } from './build-qmd.mjs'

/**
 * A stub quarto, so the failure under test is a render that failed rather than
 * a render nobody ran. It writes the deck's HTML beside the source the way a
 * `type: default` profile render does, and refuses the deck it is told to.
 */
function stubQuarto(root, brokenDeck) {
  const path = join(root, 'quarto-stub')
  writeFileSync(path, [
    '#!/bin/sh',
    '# args: render <file> --profile slides',
    'file="$2"',
    `if [ "$file" = "${brokenDeck}" ]; then`,
    '  echo "ERROR: chunk 3 failed" >&2',
    '  exit 1',
    'fi',
    'out="${file%.qmd}.html"',
    'mkdir -p "$(dirname "$out")"',
    'printf \'<html><body><div class="reveal"><div class="slides"><section id="s1"><h1>Slide</h1></section></div></div></body></html>\' > "$out"',
    '',
  ].join('\n'))
  chmodSync(path, 0o755)
  return path
}

test('a deck that fails to render does not take its chapter down with it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-failure-'))
  try {
    mkdirSync(join(root, 'lectures'), { recursive: true })
    mkdirSync(join(root, '_book', 'lectures'), { recursive: true })
    const good = 'lectures/good-slides.qmd'
    const broken = 'lectures/broken-slides.qmd'
    writeFileSync(join(root, good), '# deck\n')
    writeFileSync(join(root, broken), '# deck\n')
    // The last good render of the deck that is about to fail.
    writeFileSync(join(root, '_book', 'lectures', 'broken-slides.html'), 'THE LAST GOOD DECK')

    const log = []
    const failed = await renderDeckSet(stubQuarto(root, broken), root, [good, broken], (line) => log.push(String(line)))

    assert.deepEqual([...failed], [broken], 'only the broken deck is reported failed')

    // What the build then does with that verdict.
    for (const deck of [good, broken]) {
      if (failed.has(deck)) continue
      publishDeckIntoBook(root, join(root, '_book'), deck)
    }

    assert.match(
      readFileSync(join(root, '_book', 'lectures', 'good-slides.html'), 'utf8'),
      /class="reveal"/,
      'the deck that rendered is published',
    )
    assert.equal(
      readFileSync(join(root, '_book', 'lectures', 'broken-slides.html'), 'utf8'),
      'THE LAST GOOD DECK',
      'the deck that failed keeps serving its last good render, never a half-written one',
    )

    // `[build] ` is what the build/errors endpoint reads out of build.log for a
    // qmd project. A failure only in the progress log reaches no one.
    const marked = log.filter((line) => line.startsWith('[build] '))
    assert.equal(marked.length, 1, `expected one [build] line, got ${JSON.stringify(log)}`)
    assert.match(marked[0], /broken-slides\.qmd/, 'the error names the deck that failed')
    assert.match(marked[0], /chunk 3 failed/, "the error carries quarto's reason")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a deck set with nothing broken reports no failures and no errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-deck-all-good-'))
  try {
    mkdirSync(join(root, 'lectures'), { recursive: true })
    const good = 'lectures/good-slides.qmd'
    writeFileSync(join(root, good), '# deck\n')

    const log = []
    const failed = await renderDeckSet(stubQuarto(root, 'lectures/nothing.qmd'), root, [good], (line) => log.push(String(line)))

    assert.equal(failed.size, 0)
    assert.equal(log.filter((line) => line.startsWith('[build] ')).length, 0, 'a clean build reports no error')
    assert.equal(existsSync(join(root, 'lectures', 'good-slides.html')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
