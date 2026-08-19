/**
 * The wire between a checkout's proposal and the server's accept.
 *
 * The daemon commits the project's members (`daemon/source-proposal.mjs`), bundles what
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
   * Propose the project's members to the server.
   *
   * Returns the accept result, or a refusal that survived a rebase — which
   * means somebody else landed twice while we were writing. That is reported
   * rather than looped on: the next change re-proposes anyway, and a loop here
   * would be a retry machine with no one watching it.
   */
  /**
   * `members` is the project's COMPLETE member set, not what changed.
   *
   * The tree is the manifest, so shedding is a smaller tree and there is
   * nothing to name as deleted. The caller owes one property this file cannot
   * check: the set must be computed from the commit's tree rather than from the
   * moving disk.
   */
  async function push({ members = null, changed = [], deleted = [], editedBy = null, sourceBindingId = null, requestId = null } = {}) {
    // A caller with a closure passes `members`. A caller that only knows what
    // moved hands over the delta and the member set is derived FROM THE LAST
    // COMMIT'S TREE -- see `membersFrom`, which is the bridge until the closure
    // exists. Either way what reaches the proposal is the complete set.
    const memberSet = members || await proposal.membersFrom(await proposal.local() || await proposal.held(), { changed, deleted })
    const proposed = await proposal.proposeCommit({ members: memberSet })
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
      // **Their member set, not ours.** A path they added is in their tree and
      // not in ours, and under complete-tree semantics a member we do not name
      // is a member we DELETE. Deriving from their head is what stops our
      // proposal from removing the file they just added.
      const rebased = await proposal.rebaseOnto(head, {
        members: members || await proposal.membersFrom(head, { changed, deleted }),
      })
      // **The settle loop holds while any member path is conflicted**, and this
      // is the clause that carries the guarantee rather than computes anything.
      // The merge brought the working copy forward; where it could not, two
      // people changed the same lines and the markers are in the file. Proposing
      // now would pick a side silently, which is the failure the merge exists to
      // prevent -- so the change stays here, with the person who can resolve it.
      if (rebased.status === 'conflicted') {
        log?.warn?.(`${project}: holding at ${head.slice(0, 7)} — ${rebased.conflicted.length} path(s) need a person`)
        return {
          ok: false,
          status: 'conflicted',
          currentRevision: head,
          conflicted: rebased.conflicted,
          attempts: attempt,
        }
      }
      have = head
    }

    // Unreachable: the loop returns on every path. Throwing rather than
    // returning undefined, because a caller reading `.ok` off undefined is how
    // a failure becomes a success.
    throw new Error(`${project}: proposal loop ended without a result`)
  }

  return { push, fetchMissing }
}
