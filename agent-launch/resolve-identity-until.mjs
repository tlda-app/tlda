// Poll any harness adapter's `resolveLiveSessionIdentity` until it produces a
// session id, the process dies, or the deadline passes.
//
// It takes the resolver as an argument, so the caller picks it from
// `liveIdentityResolverMap()` rather than importing one harness's. That is the
// whole reason this exists: the daemon's deferred session discovery was bound
// to codex's resolver by an aliased import, which is why muse never got one.
//
// TWO SEMANTICS THAT MUST NOT BE DROPPED, both load-bearing on the mint path:
//
//   isProcessAlive  checked BEFORE each attempt. Without it this polls a dead
//                   process for the whole deadline, holding the mint's commit.
//   deadlineMs      the sleep is clamped to the remaining time, so the last
//                   attempt lands at the deadline rather than past it.
//
// The comment on the daemon's call site records what the async shape is for: a
// synchronous session-tree walk there once "held process_state and the
// permission grant unwritten for minutes after the agent logged in" under
// machine load.
//
// `agent-launch/harness/codex.mjs` still has its own copy of this loop, used by
// `rpcWake` and its own test. It should collapse into this one; that was left
// alone deliberately rather than edited on the mint commit path at 5am.
export async function resolveIdentityUntil({
  resolve,
  deadlineMs,
  intervalMs = 100,
  isProcessAlive = async () => true,
  now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)),
  ...resolveOptions
} = {}) {
  if (typeof resolve !== 'function') throw new TypeError('resolveIdentityUntil requires a resolver function')
  const deadline = now() + Math.max(0, Number(deadlineMs) || 0)
  while (await isProcessAlive()) {
    const live = await resolve(resolveOptions)
    if (live?.sessionId) return live
    const remaining = deadline - now()
    if (remaining <= 0) return null
    await sleep(Math.min(Math.max(1, Number(intervalMs) || 100), remaining))
  }
  return null
}
