/**
 * The wire between a checkout's proposal and the server's accept.
 *
 * The daemon commits what changed (`daemon/source-proposal.mjs`), bundles what
 * the server does not have, and POSTs the bytes. The server accepts iff the
 * commit fast-forwards. **There is no retry state machine and nothing to get
 * stuck in**: a refusal comes back naming the head it was refused against, the
 * daemon rebases its own delta onto that head, and proposes again. The daemon
 * holds the change, so the daemon is the party that can move it.
 *
 * **Why a refusal fetches before it rebases.** A 409 names `currentRevision`,
 * which is by definition somebody else's commit — and a checkout cannot rebase
 * onto objects it does not have. The mirror does deliver those objects on
 * accept, to every bound checkout, but that is a race the 409 can win. A
 * recovery path that works only when it loses a race is the failure shape this
 * replacement exists to remove, so the proposer asks for the commits outright.
 */

const ATTEMPTS = 2

export function createSourcePush({ proposal, project, server, token, fetchImpl = fetch, log = null }) {
  if (!proposal) throw new Error('createSourcePush requires a proposal')
  if (!project) throw new Error('createSourcePush requires a project')
  if (!server) throw new Error('createSourcePush requires a server')

  const url = path => `${server}/api/projects/${encodeURIComponent(project)}${path}`
  const auth = token ? { authorization: `Bearer ${token}` } : {}

  async function fetchMissing(have) {
    const response = await fetchImpl(url(`/source-bundle${have ? `?have=${encodeURIComponent(have)}` : ''}`), {
      headers: { ...auth },
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload.bundleBase64) {
      throw new Error(`${project}: could not fetch the head we were refused against (${response.status})`)
    }
    await proposal.ingest(payload.bundleBase64)
    return payload
  }

  /**
   * Propose `changed` and `deleted` to the server.
   *
   * Returns the accept result, or a refusal that survived a rebase — which
   * means somebody else landed twice while we were writing. That is reported
   * rather than looped on: the next change re-proposes anyway, and a loop here
   * would be a retry machine with no one watching it.
   */
  async function push({ changed = [], deleted = [], editedBy = null, sourceBindingId = null, requestId = null } = {}) {
    const proposed = await proposal.proposeCommit({ changed, deleted })
    if (!proposed.changed) return { ok: true, status: 'nothing-to-propose', sourceRevision: proposed.commit }

    // What we believe the server has. `held` is what the mirror last applied
    // here, so it is a fact rather than a guess -- and when it is wrong,
    // `bundleSince` ships the whole history instead of a range, which is
    // expensive and correct. Under-sending would be cheap and unrecoverable.
    let have = await proposal.held()

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const bundle = await proposal.bundleSince(have)
      const response = await fetchImpl(url('/source-bundle'), {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          ...(editedBy ? { 'x-tlda-edited-by': editedBy } : {}),
          ...(sourceBindingId ? { 'x-tlda-source-binding': sourceBindingId } : {}),
          ...(requestId ? { 'x-tlda-request-id': requestId } : {}),
        },
        body: bundle,
      })
      const payload = await response.json().catch(() => ({}))

      if (response.ok) {
        log?.info?.(`${project}: accepted ${String(payload.sourceRevision).slice(0, 7)} (${payload.postAcceptEffects?.join?.(', ') || 'no effects reported'})`)
        return { ok: true, ...payload, bytes: bundle.length, attempts: attempt }
      }

      if (response.status !== 409) {
        throw new Error(`${project}: proposing failed (${response.status}) ${payload.error || ''}`.trim())
      }

      if (attempt === ATTEMPTS) {
        log?.warn?.(`${project}: still refused after rebasing onto ${String(payload.currentRevision).slice(0, 7)}`)
        return { ok: false, status: 'refused-after-rebase', ...payload, attempts: attempt }
      }

      const head = payload.currentRevision
      if (!head) throw new Error(`${project}: refused without naming a head to rebase onto`)
      if (!(await proposal.hasCommit(head))) await fetchMissing(have)
      if (!(await proposal.hasCommit(head))) {
        throw new Error(`${project}: the server refused against ${head.slice(0, 7)} and did not send it`)
      }
      await proposal.rebaseOnto(head, { changed, deleted })
      have = head
    }

    // Unreachable: the loop returns on every path. Throwing rather than
    // returning undefined, because a caller reading `.ok` off undefined is how
    // a failure becomes a success.
    throw new Error(`${project}: proposal loop ended without a result`)
  }

  return { push, fetchMissing }
}
