import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrettyPrintTool, PRETTY_PRINT_TOOLS } from '../shared/activity-tool-classification.mjs'

// The producer side decides whether to carry a tool's result to the browser.
// The render side decides whether anything reads it. When those two disagree the
// result is built, truncated, queued, sent and stored, then dropped unread — so
// this pins them together.
//
// This mirrors `semanticOperationKind()` in src/fleet/activity-render.mjs, which
// is not importable here (it pulls in browser render code). Keep them in step.
const rendersFromDatabaseInsteadOfResult = (toolName: string) => {
  const tool = String(toolName || '').toLowerCase().replace(/^mcp__/, 'mcp/').replace(/__/g, '/')
  return tool.includes('thread') || tool.includes('search')
}

test('no tool that renders from the database carries a result body', () => {
  for (const tool of PRETTY_PRINT_TOOLS) {
    assert.equal(
      rendersFromDatabaseInsteadOfResult(tool),
      false,
      `${tool} is a semantic operation — its carried body is discarded at render`,
    )
  }
})

test('thread and search are not pretty-print tools, under any alias', () => {
  for (const alias of [
    'thread', 'search',
    'tlda__thread', 'tlda__search',
    'mcp__tlda__thread', 'mcp__tlda__search',
  ]) {
    assert.equal(isPrettyPrintTool(alias), false, `${alias} should not carry a result body`)
  }
})

test('inbox still carries its body — its card is built from the result', () => {
  // MARKDOWN_PRETTY_TOOLS in activity-render.mjs renders inbox from the carried
  // text, so removing it would empty the card. A test caught this once already.
  for (const alias of ['inbox', 'tlda__inbox', 'mcp__tlda__inbox']) {
    assert.equal(isPrettyPrintTool(alias), true, `${alias} must keep its result body`)
  }
})

test('the surfaces that render their own result keep it', () => {
  for (const alias of ['screenshot', 'mcp__tlda__screenshot', 'propose_edit', 'region_transfer', 'ScheduleWakeup']) {
    assert.equal(isPrettyPrintTool(alias), true, `${alias} must keep its result body`)
  }
})
