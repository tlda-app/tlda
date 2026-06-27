import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// A spawning ("optimistic") agent must be a first-class chat target the instant
// you hit spawn: its name is draggable to filter the chat, exactly like a live
// agent. The filter value must be opt.name — the friendly_name the agent will
// register with — so the filter carries over once the agent inhabits.
const source = readFileSync(new URL('../src/shapes/FleetAgentsShape.tsx', import.meta.url), 'utf8')

test('OptimisticAgentRow receives the same drag handler as live AgentRow', () => {
  // The render site passes startDrag through to the optimistic card.
  assert.match(
    source,
    /<OptimisticAgentRow[\s\S]*?onStartDrag=\{startDrag\}/,
    'OptimisticAgentRow must be given onStartDrag={startDrag} at its render site',
  )
  // The component declares the prop with the same signature as AgentRow.
  assert.match(
    source,
    /onStartDrag:\s*\(e:\s*React\.PointerEvent,\s*pillType:\s*'agent'\s*\|\s*'label',\s*value:\s*string,\s*displayName:\s*string,\s*color:\s*string\)\s*=>\s*void/,
  )
})

test('pending agent name is a drag source filtering on opt.name', () => {
  // Drag is gated to a named, non-errored card (an errored spawn is not a real
  // agent and an unnamed card has nothing to filter on).
  assert.match(source, /const canDrag = !isError && !!opt\.name/)
  // The name span wires onPointerDown -> onStartDrag with opt.name as BOTH the
  // filter value and the display name, so the chat filter matches the agent once
  // it registers under that friendly_name.
  assert.match(
    source,
    /onPointerDown=\{canDrag\s*\?\s*\(e\)\s*=>\s*\{\s*e\.stopPropagation\(\);\s*onStartDrag\(e,\s*'agent',\s*opt\.name!,\s*opt\.name!,\s*dragColor\)\s*\}\s*:\s*undefined\}/,
  )
})

test('drag affordance stays minimal — no uninvited visual chrome', () => {
  // appearance-requires-permission: behavior-only change. The only allowed
  // affordance is cursor:grab + touch-action:none (invisible in static render).
  // The pending name must NOT borrow the live agent's pill styling class.
  const nameSpan =
    source.match(/<span\s+className="fleet-agents-col-name"[\s\S]*?onPointerDown=\{canDrag[\s\S]*?>/)?.[0] || ''
  assert.ok(nameSpan, 'optimistic name span not found')
  assert.match(nameSpan, /cursor:\s*'grab',\s*touchAction:\s*'none'/)
  assert.doesNotMatch(nameSpan, /fleet-agents-pill/, 'must not add the live-agent pill styling to a pending card')
})
