import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { buildFailureRetentionText } from '../src/fleet/build-failure-retention.mjs'

// The card renderer is inline in the chat shape and draws HTML strings, so this
// reads the source the way the repo's other renderer tests do. What it pins is
// not the markup but the fields: the server sends seven things on a build card
// and the renderer read five of them, so a build that produced only warnings
// drew a header and an empty body. Skip: "i can see build cards now but there's
// bvasically no info in them."
const chat = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/shapes/fleet-chat.css', import.meta.url), 'utf8')

const card = chat.slice(
  chat.indexOf("m.metadata?.type === 'build_result'"),
  chat.indexOf(":build`, html })"),
)

test('the renderer reads every field the server puts on a build card', () => {
  const sent = server
    .slice(server.indexOf("if (event?.type === 'build-card'"), server.indexOf("const subs = new Set("))
    .match(/^\s{6}(\w+)[,:]/gm)
    .map(line => line.trim().replace(/[,:]$/, ''))
  // Both spellings: the metadata object writes some fields `name: value` and
  // some as shorthand, and a pattern that only saw the colon form missed
  // `errors`, `warnings` and `lintFindings` — three of the five things a reader
  // opens the card for. A check that cannot see the field it is checking for
  // passes for the wrong reason.
  // Addressing and staleness, not content: these name who the card goes to and
  // which build preceded it, and the card is not the place to draw them.
  const notContent = new Set(['type', 'name', 'lastMirrorSuccess', 'lastBuildSuccess'])
  for (const field of sent) {
    if (notContent.has(field)) continue
    assert.ok(card.includes(field), `the build card renderer drops "${field}", which the server sends`)
  }
})

test('a build with only warnings has a body and says so on its header', () => {
  assert.match(card, /warnings\.length > 0/, 'warnings must open the body')
  assert.match(card, /build-result-warning-badge/, 'the warning count belongs on the header, which is the whole card until it is clicked')
  assert.match(card, /warnings\.map/, 'the warnings themselves must be drawn')
})

test('a failed build renders the retention message carried by its payload', () => {
  assert.match(card, /lastBuildSuccess/)
  assert.match(card, /buildFailureRetentionText\(lastBuildSuccess\)/)
})

test('a failed build names the prior successful version only when one exists', () => {
  assert.equal(
    buildFailureRetentionText('2026-09-21T10:35:37.845Z', () => 'Sep 21, 2026'),
    'The last successful built version from Sep 21, 2026 remains served.',
  )
  assert.equal(
    buildFailureRetentionText(null),
    'No successful built version is available to serve.',
  )
  assert.equal(
    buildFailureRetentionText('not-a-date'),
    'No successful built version is available to serve.',
  )
})

test('every class the card draws has a style', () => {
  for (const cls of [...card.matchAll(/class="(build-result-[a-z-]+)"/g)].map(m => m[1])) {
    assert.ok(css.includes(`.${cls}`), `${cls} is drawn by the renderer and has no rule, so it renders as unmarked body text`)
  }
})
