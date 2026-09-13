// Fixtures are hand-written. Nothing is rendered.
//
// Every assertion is on the LINKED output, never on the input -- the
// annotation trap in AGENTS.md is exactly this: a check that matches the
// source text as readily as the result. So the fixtures use ref ids that do
// not appear in the expected output ("thm-pythagoras" -> "1.2"), and the
// resolved assertions look for the produced number, which only a successful
// link can create.

import { JSDOM } from 'jsdom'
import { resolveCrossrefsInDoc } from './book-crossref-link.mjs'
import assert from 'node:assert/strict'

const FORMAT = {
  language: {
    'crossref-ch-prefix': 'Chapter',
    'crossref-apx-prefix': 'Appendix',
    'crossref-sec-prefix': 'Section',
  },
  pandoc: {},
}

// One merged index covering two chapters. chapter-7 is deliberately ABSENT
// from entries, to stand for "not compiled yet".
const INDEX = {
  files: {
    'lectures/chapter-one.html': { chapters: true },
    'lectures/chapter-two.html': { chapters: true },
  },
  entries: {
    'thm-pythagoras': {
      key: 'thm-pythagoras', caption: 'Pythagoras',
      order: { number: 2, section: [1, 0, 0, 0, 0, 0, 0] },
      file: 'lectures/chapter-one.html',
    },
    'fig-scatter': {
      key: 'fig-scatter', caption: 'A scatterplot',
      order: { number: 3, section: [2, 0, 0, 0, 0, 0, 0] },
      file: 'lectures/chapter-two.html',
    },
    'sec-intro': {
      key: 'sec-intro', caption: 'Introduction',
      order: { number: 1, section: [2, 0, 0, 0, 0, 0, 0] },
      file: 'lectures/chapter-two.html',
    },
  },
  headings: {
    'a-heading-elsewhere': { id: 'a-heading-elsewhere', files: ['lectures/chapter-two.html'] },
  },
}

// The same index after chapter seven has been compiled.
const INDEX_LATER = {
  ...INDEX,
  files: { ...INDEX.files, 'lectures/chapter-seven.html': { chapters: true } },
  entries: {
    ...INDEX.entries,
    'thm-not-yet-compiled': {
      key: 'thm-not-yet-compiled', caption: '',
      order: { number: 1, section: [7, 0, 0, 0, 0, 0, 0] },
      file: 'lectures/chapter-seven.html',
    },
  },
}

const page = (body) => new JSDOM(`<html><body>${body}</body></html>`).window.document
const unresolved = (id) =>
  `<a href="#${id}"><span class="quarto-unresolved-ref">${id}</span></a>`

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`) }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nresolving')

check('resolves a same-chapter ref to its number and drops the marker class', () => {
  const doc = page(unresolved('thm-pythagoras'))
  const counts = resolveCrossrefsInDoc(
    'lectures/chapter-one.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(counts.resolved, 1)
  const span = doc.querySelector('span')
  assert.equal(span.textContent, '1.2', 'number produced by the link, not present in input')
  assert.equal(span.className, '', 'marker class removed')
  // same file => href untouched
  assert.equal(doc.querySelector('a').getAttribute('href'), '#thm-pythagoras')
})

check('rewrites the href for a cross-chapter ref, relative to the linking page', () => {
  const doc = page(unresolved('fig-scatter'))
  resolveCrossrefsInDoc('lectures/chapter-one.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(doc.querySelector('span').textContent, '2.3')
  assert.equal(doc.querySelector('a').getAttribute('href'), 'chapter-two.html#fig-scatter')
})

check('relative path climbs out of a subdirectory', () => {
  const doc = page(unresolved('fig-scatter'))
  resolveCrossrefsInDoc('index.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(doc.querySelector('a').getAttribute('href'),
    'lectures/chapter-two.html#fig-scatter')
})

check('a section ref gets its prefix word', () => {
  const doc = page(unresolved('sec-intro'))
  resolveCrossrefsInDoc('lectures/chapter-one.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(doc.querySelector('span').textContent, 'Chapter 2')
})

console.log('\ndeclining')

check('a ref into an uncompiled chapter does NOT throw', () => {
  const doc = page(unresolved('thm-not-yet-compiled'))
  const counts = resolveCrossrefsInDoc(
    'lectures/chapter-one.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(counts.unresolved, 1)
  assert.equal(counts.resolved, 0)
})

check('it warns naming the id', () => {
  const doc = page(unresolved('thm-not-yet-compiled'))
  const warnings = []
  resolveCrossrefsInDoc('lectures/chapter-one.html', FORMAT, doc, INDEX,
    { warn: (m) => warnings.push(m) })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /@thm-not-yet-compiled/)
})

// --- the pair that justifies the divergence -------------------------------
//
// These two are the whole argument for not copying quarto here. The first
// shows what their behaviour costs us; the second shows what ours buys.
// If someone "fixes" link-page.mjs back to quarto's behaviour, the second
// one fails.

// quarto's behaviour, reproduced locally so the cost is visible in the suite
const quartoUnresolvedBehaviour = (doc, id) => {
  const ref = doc.querySelector('.quarto-unresolved-ref')
  const parentLink = ref.parentElement
  const span = doc.createElement('span')
  span.classList.add('quarto-unresolved-ref')
  span.innerHTML = `?${id}`
  parentLink.parentElement.insertBefore(span, parentLink)
  parentLink.remove()
}

check('WHY WE DIVERGE: quarto destroys the anchor, so a later pass can never link it', () => {
  const doc = page(unresolved('thm-not-yet-compiled'))
  quartoUnresolvedBehaviour(doc, 'thm-not-yet-compiled')
  assert.equal(doc.querySelector('a'), null, 'quarto removes the <a>')
  const counts = resolveCrossrefsInDoc(
    'lectures/chapter-one.html', FORMAT, doc, INDEX_LATER, { warn: () => {} })
  assert.equal(counts.resolved, 0, 'target now exists, but the ref is beyond recovery')
  assert.equal(doc.querySelector('a'), null, 'the link is gone for good')
})

check('THE MIRROR: ours leaves it intact, and a later pass DOES resolve it', () => {
  const doc = page(unresolved('thm-not-yet-compiled'))
  // pass one: the target chapter has not been compiled yet
  const first = resolveCrossrefsInDoc(
    'lectures/chapter-one.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(first.unresolved, 1)
  assert.equal(first.resolved, 0)
  assert.equal(doc.querySelector('a').getAttribute('href'), '#thm-not-yet-compiled',
    'anchor preserved')
  assert.equal(doc.querySelector('span').textContent, 'thm-not-yet-compiled',
    'original id preserved, NOT rewritten to ?id')

  // pass two: chapter seven now exists
  const second = resolveCrossrefsInDoc(
    'lectures/chapter-one.html', FORMAT, doc, INDEX_LATER, { warn: () => {} })
  assert.equal(second.resolved, 1, 'the same ref resolves on the later pass')
  assert.equal(doc.querySelector('span').textContent, '7.1')
  assert.equal(doc.querySelector('a').getAttribute('href'),
    'chapter-seven.html#thm-not-yet-compiled')
})

console.log('\nheading relinking')

check('a bare #id link pointing into another page is rewritten', () => {
  const doc = page('<a href="#a-heading-elsewhere">see</a>')
  const counts = resolveCrossrefsInDoc(
    'lectures/chapter-one.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(counts.relinked, 1)
  assert.equal(doc.querySelector('a').getAttribute('href'),
    'chapter-two.html#a-heading-elsewhere')
})

check('a #id link on its own page is left alone', () => {
  const doc = page('<a href="#a-heading-elsewhere">see</a>')
  const counts = resolveCrossrefsInDoc(
    'lectures/chapter-two.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(counts.relinked, 0)
  assert.equal(doc.querySelector('a').getAttribute('href'), '#a-heading-elsewhere')
})

console.log('\ndeliberate red -- this MUST fail, or the rig cannot go red')

check('DELIBERATE RED: assert the wrong number', () => {
  const doc = page(unresolved('thm-pythagoras'))
  resolveCrossrefsInDoc('lectures/chapter-one.html', FORMAT, doc, INDEX, { warn: () => {} })
  assert.equal(doc.querySelector('span').textContent, '9.9',
    'expected to fail: the real answer is 1.2')
})

console.log(`\n${failures} failure(s); exactly 1 is expected (the deliberate red).`)
process.exit(failures === 1 ? 0 : 1)
