/**
 * Whether the daemon may accept the server's ack for a `source-change` row.
 *
 * The server acking an envelope means it received the message. It does **not**
 * mean the edits inside it reached a settled state, and this gate is what keeps
 * the row until they have — so a push whose operations are still pending is not
 * forgotten because the transport succeeded.
 *
 * **It was declared inline inside the daemon's runtime construction**, which
 * meant nothing could exercise it: a test had to re-implement it and then prove
 * its own copy. It lives here so the thing under test is the thing that runs.
 * There is no behaviour change in the move.
 *
 * The case that costs a night is the first branch. A payload carrying edit
 * operations with **no recorded disposition** answers *not yet* — and if nothing
 * ever writes a disposition for it, *not yet* is permanent. A stale-base
 * rejection that carries no `authority.currentRevision` produces no retry, so no
 * disposition is written, so the row is acked and refused forever.
 */
export function createSourceChangeAckGate({ editOperationStore, outbox }) {
  if (!editOperationStore) throw new Error('createSourceChangeAckGate requires editOperationStore')
  if (!outbox) throw new Error('createSourceChangeAckGate requires outbox')

  return function sourceChangeAckGate(payload) {
    const disposition = editOperationStore.disposition(payload?.__daemon_outbox_id)
    // No disposition: a payload with no operations has nothing to wait for and
    // the ack stands. One WITH operations is waiting on something that may never
    // arrive.
    if (!disposition) return !(payload?.editOperations?.length || payload?.editOperation)
    if (disposition.kind === 'retry_pending') {
      return disposition.retry_enqueued === 1 && !!outbox.get(disposition.retry_outbox_id)
    }
    return disposition.operationIds.every(id => editOperationStore.state(id)?.state !== 'pending')
  }
}
