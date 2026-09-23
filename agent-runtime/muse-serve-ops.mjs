// Thin MSP op map for the muse harness: TLDA turn/permission/cancel verbs
// onto `muse serve` commands. Muse owns model/loop/tools/compaction/
// persistence; this module owns host lifecycle, turn admission, permissions,
// cancel, effort, and ID mapping — and nothing else.
//
// Every op takes a channel from muse-serve-host.mjs (`channel.send`) plus a
// per-agent host record the caller owns:
//
//   host = { channel, sessionId, turnId, viewCursor, approvalMode }
//
// Consequences from the compat table (do not re-derive):
// - turnId comes from the turn/start ack, never minted locally.
// - ack `status:accepted` is admission only; the outcome is the
//   `turn/completed{terminal}` view notification.
// - approval outcome is `approval/resolved`, not the decide ack.
// - userInput outcome is `userInput/settled`, not the answer ack.

import { uuid7 } from './muse-serve-host.mjs'

// clientInfo.name must match ^[a-z0-9_]+$ on 1.3.0 (SS1.4.1: `-32602 invalid
// initialize params` for dashed names like `tlda-pa`; measured on the pipe
// control). `tlda` is compliant; keep it that way.
export async function mspInitialize(channel, { clientInfo = { name: 'tlda', version: '1' } } = {}) {
  const { result } = await channel.send('initialize', { clientInfo })
  // The handshake is two steps: without the `initialized` notification every
  // subsequent command fails `-32600 Not initialized` (measured in the smoke
  // probe). The channel's notify() carries it — same stdio, no ack.
  channel.notify('initialized')
  return result
}

// Returns the result verbatim: the session id lives at
// `result.session.sessionId` (measured), not at `result.sessionId`.
export async function mspStartSession(channel, { workspaceRoot, approvalMode = 'allowAll', modelId = null, history = null } = {}) {
  if (!workspaceRoot) throw new Error('msp session/start requires a workspaceRoot')
  const params = { commandId: uuid7(), workspaceRoot, approvalMode }
  if (modelId) params.modelId = modelId
  if (history) params.history = history
  const { result } = await channel.send('session/start', params)
  return result
}

// The one unwrapping the callers need: result.session.sessionId.
export function mspSessionId(result) {
  const id = result?.session?.sessionId || result?.sessionId
  if (!id) throw new Error('msp session/start returned no session id')
  return id
}

export async function mspResumeSession(channel, { sessionId, cursor = null, history = null } = {}) {
  if (!sessionId) throw new Error('msp session/resume requires a sessionId')
  const params = { commandId: uuid7(), sessionId }
  if (cursor) params.cursor = cursor
  if (history) params.history = history
  const { result } = await channel.send('session/resume', params)
  return result
}

// TLDA send: start a turn with plain text. Returns the ack — the caller must
// wait for `turn/completed{terminal}` on the view stream for the outcome.
export async function mspSend(channel, { sessionId, text } = {}) {
  if (!sessionId) throw new Error('msp send requires a sessionId (start or resume first)')
  if (!text) throw new Error('msp send requires text')
  const { result } = await channel.send('turn/start', {
    commandId: uuid7(),
    sessionId,
    input: [{ type: 'text', text }],
  })
  return result
}

// TLDA steer: redirect the running turn. `expectedTurnId` is the exact-target
// race guard — the server rejects the steer if the turn moved on.
export async function mspSteer(channel, { sessionId, expectedTurnId, text } = {}) {
  if (!sessionId || !expectedTurnId) throw new Error('msp steer requires sessionId + expectedTurnId')
  if (!text) throw new Error('msp steer requires text')
  const { result } = await channel.send('turn/steer', {
    commandId: uuid7(),
    sessionId,
    expectedTurnId,
    input: [{ type: 'text', text }],
  })
  return result
}

// TLDA cancel: stop the running turn. `turnId` omitted cancels whatever runs.
export async function mspCancel(channel, { sessionId, turnId = null } = {}) {
  if (!sessionId) throw new Error('msp cancel requires a sessionId')
  const params = { commandId: uuid7(), sessionId }
  if (turnId) params.turnId = turnId
  const { result } = await channel.send('turn/cancel', params)
  return result
}

export async function mspSetReasoningEffort(channel, { sessionId, effort } = {}) {
  if (!sessionId) throw new Error('msp setReasoningEffort requires a sessionId')
  if (!effort) throw new Error('msp setReasoningEffort requires an effort tier')
  const { result } = await channel.send('session/setReasoningEffort', {
    commandId: uuid7(),
    sessionId,
    effort,
  })
  return result
}

// Decide a pending approval. `requirementId` must be the request's
// `currentRequirementId` — a stale one fails with -32053, and deciding after
// resolution fails with -32051. Outcome arrives on `approval/resolved`.
export async function mspDecideApproval(channel, { sessionId, approvalId, choiceId, requirementId } = {}) {
  if (!sessionId || !approvalId || !choiceId || !requirementId) {
    throw new Error('msp approval/decide requires sessionId + approvalId + choiceId + requirementId(currentRequirementId)')
  }
  const { result } = await channel.send('approval/decide', {
    commandId: uuid7(),
    sessionId,
    approvalId,
    choiceId,
    requirementId,
  })
  return result
}

// Answer a userInput request. Each answer must match its question's
// selection mode (selectedLabel vs selectedLabels vs freeText).
export async function mspAnswerUserInput(channel, { sessionId, userInputId, answers } = {}) {
  if (!sessionId || !userInputId || !answers) {
    throw new Error('msp userInput/answer requires sessionId + userInputId + answers[]')
  }
  const { result } = await channel.send('userInput/answer', {
    commandId: uuid7(),
    sessionId,
    userInputId,
    answers,
  })
  return result
}

export async function mspListPendingApprovals(channel, { sessionId } = {}) {
  if (!sessionId) throw new Error('msp approval/listPending requires a sessionId')
  const { result } = await channel.send('approval/listPending', { sessionId })
  return result
}

// Read a tool-output body behind a patchRef. `outputRef` is the item's
// patchRef verbatim.
export async function mspReadOutput(channel, { sessionId, itemId, outputRef } = {}) {
  if (!sessionId || !itemId || !outputRef) {
    throw new Error('msp item/readOutput requires sessionId + itemId + outputRef')
  }
  const { result } = await channel.send('item/readOutput', { sessionId, itemId, outputRef })
  return result
}
