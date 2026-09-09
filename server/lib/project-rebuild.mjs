/**
 * Rebuild the revision a project already holds.
 *
 * Every other way into the build queue needs a NEW revision. `source-room/files`
 * writes bytes and lets git decide, so resubmitting a file unchanged answers
 * `202 queued` and then does nothing, because there is no commit to admit. That
 * is right for editing and useless for the case this exists for: the source was
 * always fine and the BUILD failed, on an environment that has since been
 * fixed. Two week0-homework submissions sat unmarkable for five days in exactly
 * that state, and the only ways out were altering a student's bytes to
 * manufacture a revision, or restarting the server and hoping startup recovery
 * picked them up. Neither is a thing anyone should do to re-run a render.
 *
 * So this admits the proposal refs already on disk — the same records
 * `recoverProposalBuilds()` replays at startup and the same `admitProposal`
 * git-http calls on push. Re-admitting a revision is defined behaviour, not a
 * trick: the dispatcher treats equal-as-not-older so a rebuild of the same
 * revision still publishes, which is how a corrupt render has always been fixed.
 *
 * It creates nothing. A project with no proposal ref has no revision to rebuild
 * and is told so, rather than being handed a queued build that will never run.
 */
export function createProjectRebuildHandler({ readProject, sourceLifecycleStore, listProposalRefs, admitProposal }) {
  return async function rebuildProject(name) {
    if (!await readProject(name)) return { status: 404, body: { error: 'Not found' } }
    const git = await (await sourceLifecycleStore(name)).gitRepository()
    const proposals = await listProposalRefs(git.gitDir)
    if (!proposals.length) {
      return { status: 409, body: { error: `${name} has no source revision to rebuild` } }
    }
    // `retryTerminal` is the whole request. A rebuild is only ever asked for
    // when the last build reached a terminal state, and `admitBuild`
    // short-circuits an existing row unless the caller says it is retrying one:
    // it records the admission, skips the queue, and returns the failed row.
    // That is exactly the no-op a server restart produced against these two
    // projects — startup recovery re-admits without it, so their `failed` rows
    // absorbed the admission and nothing rebuilt.
    for (const proposal of proposals) {
      await admitProposal({ project: name, ...proposal }, { retryTerminal: true })
    }
    return { status: 202, body: { ok: true, status: 'queued', revisions: proposals.map(proposal => proposal.revision) } }
  }
}
