import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
// Comments here talk ABOUT console.warn, which is the thing being removed.
const withoutComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
const OPEN = read('../src/shapes/fleet-chat-markdown-open.ts')
const HOSTS = {
  '../src/shapes/FleetChatShape.tsx': read('../src/shapes/FleetChatShape.tsx'),
  '../src/shapes/FleetInboxShape.tsx': read('../src/shapes/FleetInboxShape.tsx'),
}

// These are source assertions, not behaviour: the module imports tldraw and the
// fleet socket and cannot be loaded outside a browser. Same instrument as
// tests/annotation-viewer-interaction-contract.test.mjs. What they cover is the
// failure this change is about — a report that reaches nobody — and the wire
// risk that comes with fixing it, which is an optional callback with `?.` on it
// that no caller ever supplies.

test('nothing in the chip open path reports a failure to the console alone', () => {
  assert.doesNotMatch(withoutComments(OPEN), /console\.(warn|error|log)/)
})

test('every failure path both logs and tells the person who clicked', () => {
  // Each catch/guard that ends an open without a document.
  const failures = OPEN.split('\n').reduce((acc, line, i) => {
    if (/log\.error\(/.test(line)) acc.push(i)
    return acc
  }, [])
  assert.ok(failures.length >= 4, `expected the four failure paths, found ${failures.length}`)
  const lines = OPEN.split('\n')
  for (const at of failures) {
    // The showError call sits within the same handler, a few lines below.
    const window = lines.slice(at, at + 8).join('\n')
    assert.match(
      window,
      /showError\??\.?\(?CHIP_OPEN_FAILED\)/,
      `the failure logged at line ${at + 1} does not reach the user`,
    )
  }
})

test('the message does not ask the reader which stage failed', () => {
  const message = OPEN.match(/export const CHIP_OPEN_FAILED = '([^']*)'/)?.[1]
  assert.ok(message, 'the message is exported so hosts can raise it themselves')
  for (const jargon of ['surface', 'materialize', 'fetch', 'HTTP', 'annotation-viewer', 'undefined']) {
    assert.ok(!message.includes(jargon), `the message says "${jargon}" to someone who clicked a file`)
  }
})

/** Every call to `name`, from the open paren to its match. The argument list
 *  contains parens of its own — an arrow callback, a nested call — so this
 *  counts depth rather than reaching for the next `)`. */
function callsTo(source, name) {
  const calls = []
  const opener = new RegExp(`\\b${name}\\(`, 'g')
  let match
  while ((match = opener.exec(source))) {
    let depth = 0
    for (let i = match.index + match[0].length - 1; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')' && --depth === 0) {
        calls.push(source.slice(match.index, i + 1))
        break
      }
    }
  }
  return calls
}

// The wire. An optional `showError?` that no host passes is the same silence
// with more code in it, so the assertion is on the CALLERS, not the callee.
test('every options object handed to the shared open path carries the error surface', () => {
  for (const [path, source] of Object.entries(HOSTS)) {
    // openChatMarkdownColumn's options are the ones carrying logPrefix.
    const columns = [...source.matchAll(/logPrefix: '[^']*',/g)]
    assert.ok(columns.length > 0, `${path} opens no markdown column`)
    for (const match of columns) {
      const tail = source.slice(match.index, match.index + 200)
      assert.match(tail, /showError/, `${path}: a column open near index ${match.index} is silent on failure`)
    }
    // The chip-target path, under whatever local name this host imported it as.
    // FleetChatShape aliases it; matching the bare name would hit its own
    // same-named wrapper instead of the call that crosses into the shared module.
    const imported = source.match(/openMarkdownChipFromTarget(?: as (\w+))?[,\s}][^\n]*from '\.\/fleet-chat-markdown-open'/)
    assert.ok(imported, `${path} does not import the chip open path`)
    const localName = imported[1] || 'openMarkdownChipFromTarget'
    const chips = callsTo(source, localName)
    assert.ok(chips.length > 0, `${path} opens no chip from a target`)
    for (const call of chips) {
      assert.match(call, /showError/, `${path}: a chip open is silent on failure`)
    }
  }
})

test('the error surface is a toast, which is immobile UI rather than a shape', () => {
  for (const [path, source] of Object.entries(HOSTS)) {
    assert.match(source, /useToasts/, `${path} does not reach the toast surface`)
    assert.match(
      source,
      /addToast\(\{ title: message, severity: 'error' \}\)/,
      `${path} raises the failure some other way`,
    )
  }
})
