import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const INJECTOR = join(here, 'html-injector.mjs')

/**
 * The health probes decide whether Skip is told his chapter is broken, so the
 * question these tests exist for is not "do they run" but "can they be wrong in
 * the two directions that matter".
 *
 * Both directions have already happened once, on a real page, which is why each
 * has a test here rather than a comment:
 *
 *   FALSE ALARM. The first webR probe counted `.cell-code .sourceCode` — every
 *   static code listing on every Quarto page — and reported 38 broken webR cells
 *   on a page with no webR on it at all. A detector that cries wolf is one
 *   somebody switches off, and then the real fault goes with it.
 *
 *   FALSE ALL-CLEAR. Reporting `ok` for a capability that is simply not on the
 *   page. That is how `verify-katex-switch.sh` came to pass against a cut of the
 *   book with no maths in it: the check answered about nothing and the answer
 *   was green. Hence three values, and `absent` is a real one.
 *
 * The probes live inside a template literal, so nothing in this repo type-checks
 * or lints them. They are extracted and evaluated the same way
 * `html-injector-bridge-syntax.test.mjs` does it — the literal is evaluated as a
 * literal, so the escaping is the runtime's rather than ours.
 */
function extractBeacon() {
  const src = readFileSync(INJECTOR, 'utf8')
  const m = /const FAULT_BEACON_SCRIPT = `/.exec(src)
  assert.ok(m, 'FAULT_BEACON_SCRIPT is gone from html-injector.mjs')
  const open = src.indexOf('`', m.index)
  const end = src.indexOf('\n`\n', open)
  assert.notEqual(end, -1, 'could not find the end of FAULT_BEACON_SCRIPT')
  const text = new vm.Script('`' + src.slice(open + 1, end) + '`').runInNewContext({})
  // The literal carries its own <script> wrapper, which is markup, not JS.
  return text.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '')
}

/**
 * The smallest DOM the probes actually touch. Deliberately hand-built rather
 * than jsdom: what is under test is which SELECTORS the probes ask for, so the
 * fake answers selector strings and records nothing else. A richer DOM would let
 * a probe pass by reading something this one happens to implement.
 */
function runProbes({ selectors = {}, innerText = '', globals = {} } = {}) {
  const el = (props = {}) => ({
    childElementCount: 0,
    getAttribute: () => null,
    textContent: '',
    ...props,
  })
  const lookup = (sel) => selectors[sel] || []
  const sandbox = {
    document: {
      readyState: 'complete',
      body: { innerText },
      querySelectorAll: (sel) => lookup(sel),
      querySelector: (sel) => lookup(sel)[0] || null,
      addEventListener: () => {},
    },
    window: {
      addEventListener: () => {},
      location: { href: 'https://example.invalid/doc.html', search: '' },
      parent: { postMessage: () => {} },
      ...globals,
    },
    navigator: { sendBeacon: () => true },
    location: { href: 'https://example.invalid/doc.html' },
    URLSearchParams: class { get() { return '' } },
    Blob: class {},
    setTimeout: () => {},
    fetch: () => ({ catch: () => {} }),
    JSON,
    Object,
    String,
    Date,
  }
  sandbox.window.window = sandbox.window
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  new vm.Script(extractBeacon()).runInContext(sandbox)
  assert.equal(typeof sandbox.window.__tldaDocHealthCheck, 'function',
    'the beacon did not expose its check')
  return sandbox.window.__tldaDocHealthCheck()
}

test('static code listings are not webR cells — the false alarm that already happened', () => {
  // A real page: 38 static R listings, no webR. Measured on
  // qtm285-calibration-solutions, where the first version of this probe called
  // every one of them a broken webR cell.
  const report = runProbes({
    selectors: {
      '.cell-code .sourceCode': new Array(38).fill(0).map(() => ({})),
    },
  })
  assert.equal(report.webr.state, 'absent')
  assert.deepEqual(Array.from(report.broken), [])
})

test('webR cells that never mounted are broken, and a mounted one is not', () => {
  const empty = { childElementCount: 0 }
  const mounted = { childElementCount: 3 }
  const sel = 'div.exercise-cell[id^="webr-"]'

  const dead = runProbes({ selectors: { [sel]: [empty, empty] } })
  assert.equal(dead.webr.state, 'broken')
  assert.equal(dead.webr.live, 0)

  const live = runProbes({ selectors: { [sel]: [mounted, mounted] } })
  assert.equal(live.webr.state, 'ok')

  // Partial is broken too: the cell that stayed empty is an exercise that is
  // dead on the page, and calling the page ok because most of it works is how
  // the one broken exercise reaches a student.
  const partial = runProbes({ selectors: { [sel]: [mounted, empty] } })
  assert.equal(partial.webr.state, 'broken')
  assert.equal(partial.webr.live, 1)
})

test('a macro that rendered as an error is reported with the renderer\'s own message', () => {
  // The shape KaTeX and MathJax actually produce for an undefined macro: an
  // error element with the parse message in its title. This is the signal for
  // Skip's symptom — clean console, visible DOM.
  const errored = {
    getAttribute: (a) => (a === 'title' ? 'Undefined control sequence \\qqtext' : null),
    textContent: '\\qqtext',
  }
  const report = runProbes({
    selectors: {
      '.katex, mjx-container': [{}, {}],
      '.katex-error, mjx-merror': [errored],
    },
  })
  assert.equal(report.math.state, 'broken')
  assert.equal(report.math.errored, 1)
  // The count alone would not tell anyone WHICH macro broke, and that sentence
  // is the whole value of the report.
  assert.match(report.math.detail, /Undefined control sequence/)
  assert.deepEqual(Array.from(report.broken), ['math'])
})

test('maths present with nothing rendering it is broken, not absent', () => {
  // The silent non-render: no error was raised, the renderer simply never ran,
  // and the TeX source is sitting in the text. No error handler can see this.
  const report = runProbes({
    selectors: { '.katex, mjx-container': [] },
    innerText: 'the estimator \\(\\hat\\mu\\) satisfies \\[ \\hat\\mu = 1 \\]',
  })
  assert.equal(report.math.state, 'broken')
  assert.equal(report.math.rendered, 0)
  assert.ok(report.math.residue > 0)
})

test('a page with no maths reports absent, never ok', () => {
  // The false all-clear. `ok` here would mean the same thing as a working
  // chapter, and that is the reading that let a cut of the book with no maths
  // in it verify a renderer switch.
  const report = runProbes({ selectors: {}, innerText: 'no mathematics here at all' })
  assert.equal(report.math.state, 'absent')
  assert.equal(report.reveal.state, 'absent')
  assert.deepEqual(Array.from(report.broken), [])
})

test('a probe that throws reports unknown, and does not take the report down with it', () => {
  // Run bare, one throwing probe kills check(): no report, no badge, and a page
  // that reads exactly like a healthy one. That is this whole mechanism's own
  // failure mode reproduced inside it — an instrument that cannot say it failed
  // to measure. `querySelectorAll` throwing is not hypothetical; an invalid or
  // unsupported selector does it.
  const report = runProbes({
    selectors: {
      get '.katex, mjx-container'() { throw new Error('selector blew up') },
    },
  })
  assert.equal(report.math.state, 'unknown')
  assert.match(report.math.why, /could not run/)
  assert.match(report.math.error, /selector blew up/)
  // Not folded into ok, and not silently counted as broken either.
  assert.deepEqual(Array.from(report.broken), [])
  assert.deepEqual(Array.from(report.unknown), ['math'])
  // The other probes still ran.
  assert.equal(report.reveal.state, 'absent')
})

test('the macro count distinguishes "KaTeX is running" from "KaTeX has his macros"', () => {
  // Rendering is not the question the flip has to answer. KaTeX with an empty
  // macro set renders every page beautifully and turns 358 uses of \qqtext into
  // literal text, so the count travels separately from the state.
  const withMacros = runProbes({
    selectors: { '.katex, mjx-container': [{}] },
    globals: { katex: {}, __tldaKatexMacros: { '\\qqtext': 'x', '\\qty': 'y' } },
  })
  assert.equal(withMacros.math.state, 'ok')
  assert.equal(withMacros.math.engine, 'katex')
  assert.equal(withMacros.math.macros, 2)

  const without = runProbes({ selectors: { '.katex, mjx-container': [{}] }, globals: { katex: {} } })
  assert.equal(without.math.macros, 0)
})
