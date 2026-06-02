// Reconcile a server echo against an *un-reconciled* optimistic chat entry — one
// that still has its `_tempId` and never received a `_dbId` because the WS reply
// that would have called reconcileOptimistic was lost during a server hiccup.
//
// Without this, the echo (which can't be matched by `_dbId`) is appended as a
// second copy, leaving the failed-marked optimistic entry AND the real one
// visible — the "⚠ not sent" + "☑ sent" duplicate.
//
// `match` selects the optimistic entry: by `_tempId` on the live broadcast path
// (the server echoes it), by content on the reconnect catch-up path (DB rows
// carry no `_tempId`). Returns true if an entry was bound.

export function bindOptimisticEcho(events, serverEventId, match) {
  const ev = events.find(e => e._tempId && !e._dbId && match(e))
  if (!ev) return false
  ev._dbId = serverEventId
  delete ev._tempId
  delete ev._failed // it actually went through — drop the "not sent" mark
  return true
}
