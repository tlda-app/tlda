import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const INJECTOR = join(here, 'html-injector.mjs')

/**
 * The injected scripts are STRINGS, so nothing that runs in this repo reads
 * them. `tsc -b` sees a template literal. `eslint` sees a template literal. A
 * syntax error inside one ships silently and the only symptom is that the
 * feature does not happen in the browser — no build failure, no lint finding,
 * no server error.
 *
 * This caught a real break while it was being written: a comment inside the
 * slides bridge used backticks around an identifier, which closed the template
 * literal early. That one at least broke the module too. A stray bracket inside
 * the script would not have, and would have reached a deck.
 *
 * Extraction evaluates the literal rather than unescaping it by hand — a
 * hand-rolled unescape got `\\/` wrong and reported a syntax error in code that
 * was fine, which is the same class of fault as the thing being guarded.
 */
function injectedScripts() {
  const src = readFileSync(INJECTOR, 'utf8')
  const found = []
  const decl = /const ([A-Z0-9_]+_SCRIPT) = `/g
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    const open = src.indexOf('`', m.index)
    const end = src.indexOf('\n`\n', open)
    if (end === -1) continue
    const raw = src.slice(open + 1, end)
    // Evaluate AS a template literal so the escaping is the runtime's, not ours.
    const real = new vm.Script('`' + raw + '`').runInNewContext({})
    found.push({ name: m[1], text: real })
  }
  return found
}

test('every injected script is syntactically valid JavaScript', () => {
  const scripts = injectedScripts()
  // A zero here would pass vacuously, which is the failure this whole file is
  // about: assert the extractor found something before trusting what it says.
  assert.ok(scripts.length > 0, 'found no injected scripts to check')

  for (const { name, text } of scripts) {
    const js = text.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '').trim()
    if (!js) continue
    assert.doesNotThrow(
      () => new vm.Script(js),
      `${name} is not valid JavaScript`,
    )
  }
})

test('the slides bridge still carries its deck-mode coordinate frame', () => {
  const bridge = injectedScripts().find(s => s.name === 'SLIDES_BRIDGE_SCRIPT')
  assert.ok(bridge, 'SLIDES_BRIDGE_SCRIPT not found')

  // Deck mode is what keeps the whole Reveal instance alive instead of locking
  // the iframe to one slide. These are the wire's two ends on this side; the
  // parent half is src/loaders/deckLayout.ts and the shape that posts to it.
  for (const literal of ['tlda-deck-extent', 'tlda-deck-layout', 'applyDeckLayout', 'reportDeckExtent']) {
    assert.ok(bridge.text.includes(literal), `bridge lost ${literal}`)
  }
})
