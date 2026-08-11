#!/usr/bin/env node
// A pill dragged out of a CHAT must reach the WM drop system, like one dragged
// from the agents panel.
//
// Skip's discriminator, 2026-08-11: dragging a label/agent pill from the agents
// panel into chat filtering works; dragging the same pill from a chat does not.
//
// The cause was not drop-target resolution — it was that FleetChatShape never
// called updateWMDrop/finishWMDrop at all, so a chat-origin drag never entered
// the system that resolves the filter zones. It went straight to
// dropPillOnTarget, which handles document drops and knows nothing about chat
// filtering. FleetAgentsShape has always called both.
//
// That also explains why the wm-drop-resolve telemetry looked clean: every one of
// those events came from the agents panel. Chat drags emitted nothing, and an
// instrument that never sees the failing path reports health.
//
// Source contract: this is capture-phase pointer drag across two tldraw editors
// with a membrane handoff, which a DOM harness does not reproduce honestly.
// Verified against the pre-fix file so it cannot pass vacuously.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const chat = readFileSync(join(repo, 'src/shapes/FleetChatShape.tsx'), 'utf8')
const agents = readFileSync(join(repo, 'src/shapes/FleetAgentsShape.tsx'), 'utf8')

// The working origin, as the reference. If this ever stops being true the fix
// below is cargo-culting a pattern that no longer exists.
assert.match(agents, /updateWMDrop\(/, 'FleetAgentsShape must still drive the WM drop system')
assert.match(agents, /finishWMDrop\(/, 'FleetAgentsShape must still finish through the WM drop system')

// The chat origin must do the same three things.
assert.match(
  chat, /updateWMDrop\(/,
  'a chat-origin pill drag must offer itself to the WM drop system while moving, '
  + 'or the filter zones never preview',
)
assert.match(
  chat, /finishWMDrop\(/,
  'a chat-origin pill drop must go through finishWMDrop, or it can never filter',
)
assert.match(
  chat, /cancelWMDrop\(/,
  'a cancelled chat drag must leave the WM drop system, or the zone keeps its preview',
)

// finishWMDrop must gate the fallback rather than run alongside it: dropping a
// pill onto a filter zone must not ALSO drop it on the document underneath.
assert.match(
  chat, /if \(!handledByDropTarget\) \{\s*\n\s*dropPillOnTarget\(/,
  'dropPillOnTarget must be the fallback when no drop target handled the pill, not an always-run sibling',
)

// And the payload must carry the fields the filter zone reads. An accepted drop
// with an empty `value` yields [] from fleetFilterForPillDrop — a silent no-op,
// which is the same failure wearing a different mask.
const finishCall = chat.slice(chat.indexOf('finishWMDrop({'), chat.indexOf('finishWMDrop({') + 400)
for (const field of ['pillType', 'value', 'displayName', 'pagePoint']) {
  assert.ok(finishCall.includes(field), `the finishWMDrop payload must carry ${field}`)
}

console.log('chat-origin pill drop: ok')
