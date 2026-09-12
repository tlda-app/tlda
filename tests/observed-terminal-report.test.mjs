import assert from 'node:assert/strict'
import test from 'node:test'

import { observedTerminalReport, windowTail } from '../shared/observed-terminal.mjs'

const PANE = [
  '  Tip: Try the Desktop app.',
  '› 💻 Call login() with the tlda MCP server. Then call inbox() to check for a pending task.',
  '  gpt-6-astra default · /private/tmp',
].join('\n')

// Skip specified three parts. Each one is here because leaving it out has a
// named cost, so each gets its own assertion rather than one match on the whole
// string.
test('the report carries the evidence, when it was observed, and how to look again', () => {
  const at = '2026-09-12T13:54:45.735Z'
  const text = observedTerminalReport('sol-eight', PANE, at)

  // 1. The evidence inline, attributed. Not "the agent may be parked" -- the
  //    pane, so the reader is not sent off to run a command to see it.
  assert.match(text, /^I, tlda, looked at sol-eight's terminal at /)
  assert.ok(text.includes('› 💻 Call login()'), 'the pane itself is in the message')
  assert.ok(text.includes('```'), 'fenced, so it renders as a terminal rather than as prose')

  // 2. When, and that it may have moved. An observation with no timestamp is
  //    indistinguishable from a live one and gets acted on as live.
  assert.ok(text.includes(at), 'the observation time is stated')
  assert.match(text, /It could have changed since\./)

  // 3. The literal thing to say, not a description of what to do.
  assert.ok(text.includes('To look again, say: terminal(agent: "sol-eight")'))
})

test('a missing timestamp becomes now rather than being left off', () => {
  const text = observedTerminalReport('sol-eight', PANE)
  // The failure mode is a report with no time on it, not a report with a
  // slightly wrong time.
  assert.match(text, /looked at sol-eight's terminal at \d{4}-\d{2}-\d{2}T[\d:.]+Z/)
  assert.match(text, /It could have changed since\./)
})

test('the label the reader would type is what the command carries', () => {
  // Never an id: the point of part three is that it can be said as written.
  const text = observedTerminalReport('muse-spark-eval', PANE, '2026-09-12T00:00:00.000Z')
  assert.ok(text.includes('terminal(agent: "muse-spark-eval")'))
})

test('the tail is taken from the end, because the prompt is at the bottom', () => {
  const pane = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(windowTail(pane, 3), 'line 197\nline 198\nline 199')
  // A head-biased window would show a splash screen and cut off the composer,
  // which is the one line that answers the question.
  assert.ok(observedTerminalReport('a', pane, 'T', 3).includes('line 199'))
  assert.ok(!observedTerminalReport('a', pane, 'T', 3).includes('line 0\n'))
})

test('a pane that is absent does not throw', () => {
  // The notice must go out even when the capture failed; this renderer is not
  // the place that decides that, but it must not be the place that breaks it.
  assert.doesNotThrow(() => observedTerminalReport('a', undefined, 'T'))
  assert.doesNotThrow(() => observedTerminalReport('a', null, 'T'))
})
