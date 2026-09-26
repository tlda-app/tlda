import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Regression test for the diff-view settled-state font fallback on
// balancing-act p11 (shadow 2447672): 44 text runs rendered in fallback
// families. Root cause: the font-class regexes in svgWordSpaces.ts and
// svgFonts.ts used (\w+) for the class/font tokens, which cannot match the
// hyphen in dvisvgm class names like text.f10{font-family:rm-lmr7;…} — so
// f5/f6/f10 (the classes behind 41/44 swapped runs) got no inline
// font-family/font-size and fell back to a same-named class rule from the
// other mounted SVG. This test pins the regexes against the real saved
// artifact /private/tmp/cur-p11.svg plus the exact swapped classes.

const svgWordSpacesSrc = readFileSync(
  new URL('../src/svgWordSpaces.ts', import.meta.url),
  'utf8',
)
const svgFontsSrc = readFileSync(
  new URL('../src/svgFonts.ts', import.meta.url),
  'utf8',
)

function extractClassRes(src) {
  // Collect every /text\.…/g literal used to parse font classes.
  const out = []
  const re = /\/text\\\.\(([^)]+)\)\\s\*\\\{font-family:\(([^)]+)\);font-size:\(([^)]+)\)px\\\}\/g/g
  let m
  while ((m = re.exec(src)) !== null) out.push(new RegExp(`text\\.(${m[1]})\\s*\\{font-family:(${m[2]});font-size:(${m[3]})px\\}`, 'g'))
  return out
}

const curSvg = readFileSync('/private/tmp/cur-p11.svg', 'utf8')
const styleCss = curSvg.match(/<style[^>]*>(.*?)<\/style>/s)[1]
// The classes behind the 44 swapped runs: 41 are f10/f6/f5 (f10 alone is 38),
// the other 3 are tspan-combined rows rendered from the same missed set.
const SWAP_CLASSES = ['f5', 'f6', 'f10']

test('svgWordSpaces class regex parses hyphenated classes incl. the 44-swap set', () => {
  const res = extractClassRes(svgWordSpacesSrc)
  assert.ok(res.length > 0, 'no font-class regex found in svgWordSpaces.ts')
  const found = {}
  for (const re of res) {
    let m
    while ((m = re.exec(styleCss)) !== null) found[m[1]] = [m[2], m[3]]
  }
  assert.equal(Object.keys(found).length, 15, `expected all 15 classes, got ${Object.keys(found).length}`)
  for (const c of SWAP_CLASSES) {
    assert.ok(found[c], `swap class ${c} not parsed (old (\\w+) regex misses it)`)
  }
  assert.deepEqual(found.f10, ['rm-lmr7', '6.973848'])
  assert.deepEqual(found.f6, ['ec-lmbx10', '9.96264'])
  assert.deepEqual(found.f5, ['ec-lmr7', '6.973848'])
})

test('svgFonts parseFontClasses regex parses hyphenated classes incl. the 44-swap set', () => {
  const res = extractClassRes(svgFontsSrc)
  assert.ok(res.length > 0, 'no font-class regex found in svgFonts.ts')
  const found = {}
  for (const re of res) {
    let m
    while ((m = re.exec(styleCss)) !== null) found[m[1]] = [m[2], m[3]]
  }
  for (const c of SWAP_CLASSES) {
    assert.ok(found[c], `swap class ${c} not parsed (old (\\w+) regex misses it)`)
  }
  assert.deepEqual(found.f10, ['rm-lmr7', '6.973848'])
})

test('every class used by a <text> element is parsed (no silent miss)', () => {
  const res = extractClassRes(svgWordSpacesSrc)
  const uses = new Set([...curSvg.matchAll(/<text[^>]*class='([\w-]+)'/g)].map((m) => m[1]))
  const found = new Set()
  for (const re of res) {
    let m
    while ((m = re.exec(styleCss)) !== null) found.add(m[1])
  }
  const missed = [...uses].filter((c) => !found.has(c))
  assert.deepEqual(missed, [], `classes used but never parsed: ${missed}`)
})
