// DRAFT — not wired in. Written here to be read before it goes into
// server/lib/project-promotion.mjs, which is delicate and writes to the box
// students read.
//
// INTENTION, written before the code so the appraisal has something to fail
// against: let a promotion land on a destination that already has the project,
// so a caller for `POST /api/projects/:name/promote` can publish week two
// instead of refusing with `already exists`. Reuse the swap the build
// publication path already performs. Destroy nothing: the destination's
// revision history must accumulate, because the promotion record lives in it
// and a wholesale replace would delete the very thing that answers "when was
// this last published".

// ---------------------------------------------------------------------------
// 1. The shared swap. Extracted from server/lib/build-dispatch.mjs rather than
//    copied: two encodings of "how a published directory is replaced" is the
//    defect this project keeps paying for. build-dispatch keeps its
//    PUBLISH_REPLACED_ITEMS list, which is about what a BUILD replaces and is
//    a different fact from what a PROMOTION carries.
//
//    A new file rather than an import from build-dispatch, because that module
//    pulls in sync-rooms and project-store, and project-promotion is imported
//    by a unit test that must not stand up either.
// ---------------------------------------------------------------------------

// server/lib/published-item-swap.mjs
export function moveAside(live, transaction, name) {
  const held = join(transaction, `old-${name}`)
  if (existsSync(live)) renameSync(live, held)
  return held
}

export function restoreAside(live, held) {
  if (!existsSync(held)) return
  if (existsSync(live)) rmSync(live, { recursive: true, force: true })
  renameSync(held, live)
}

// ---------------------------------------------------------------------------
// 2. What a promotion replaces on a destination that already has the project.
//
//    NOT the same list as PUBLISH_REPLACED_ITEMS. A build replaces
//    `build-cache` and `latex.log`; a promotion stream carries neither, and
//    swapping an item the stream never sent for nothing is a silent deletion —
//    the exact failure build-dispatch's OPTIONALLY_ABSENT_PUBLISHED_ITEMS
//    comment describes.
//
//    `.source-lifecycle` is deliberately absent: it is advanced additively
//    below, never swapped.
// ---------------------------------------------------------------------------
const PROMOTION_REPLACED_ITEMS = Object.freeze(['source', 'output', 'build.log', 'project.json'])

// ---------------------------------------------------------------------------
// 3. Is this the same promotion we already have? Then say so and change
//    nothing.
//
//    This is v1's `existingPromotionMatches`, ported. v1 had it and the v2
//    stream rewrite dropped it; the two tests that cover it
//    (`identical retry is idempotent`, `same revision with different existing
//    output is not an identical retry`) exercise only the v1 function, which
//    has no production caller — which is why the gap read as covered.
//
//    Compared by the header the destination just verified, not by re-hashing
//    the live tree against a recomputed artifact: every member's sha256 was
//    checked as it was written, so the staged copy is known-good and the
//    question is only whether the live copy is the same revision.
// ---------------------------------------------------------------------------
async function promotedRevisionMatches(destination, revision, header) {
  try {
    const operations = JSON.parse(await readFile(join(destination, '.source-lifecycle', 'operations.json'), 'utf8'))
    const lifecycle = operations.revisionLifecycle?.[revision]
    if (!lifecycle || stableJson(lifecycle) !== stableJson(header.lifecycle)) return false
    const metadata = JSON.parse(await readFile(join(destination, 'project.json'), 'utf8'))
    if (stableJson(metadata) !== stableJson(header.metadata)) return false
    const gitDir = join(destination, '.source-lifecycle', 'git')
    const sourceRef = `refs/tlda/source/${encodeRefComponent(header.name)}`
    const head = (await execFileAsync('git', [`--git-dir=${gitDir}`, 'rev-parse', `${sourceRef}^{commit}`], { encoding: 'utf8' })).stdout.trim()
    if (head !== revision) return false
    // The render, by content. A destination carrying the right revision and
    // the wrong bytes is the case that must NOT report itself already
    // promoted: it is what a half-finished earlier swap leaves behind.
    for (const member of header.members) {
      if (member.kind !== 'output') continue
      const path = join(destination, 'output', ...member.path.split('/'))
      if (!existsSync(path) || await fileDigest(path) !== member.sha256) return false
    }
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 4. The swap itself.
//
//    `pending` and `destination` are siblings under the projects root, so every
//    move here is a same-filesystem rename — no cross-filesystem copy, which is
//    what made the build path's equivalent a 101-second event-loop stall until
//    it was made async.
//
//    Rollback covers all four kinds of change, in reverse:
//      - the swapped items, from the transaction directory
//      - the source ref, to the value it had
//      - operations.json, from the transaction directory
//    A crash mid-swap leaves the transaction directory with an `old-` copy of
//    everything it had taken, which is the same shape build-dispatch's
//    `recoverBuildPublications` already knows how to reason about.
// ---------------------------------------------------------------------------
async function republishOverExisting({ destination, pending, name, revision, header }) {
  const gitDir = join(destination, '.source-lifecycle', 'git')
  const pendingGitDir = join(pending, '.source-lifecycle', 'git')
  const sourceRef = `refs/tlda/source/${encodeRefComponent(name)}`
  const transaction = join(destination, `.promotion-publish-${process.pid}-${randomUUID()}`)
  await mkdir(transaction, { recursive: true })

  // Written before anything moves, so a crash leaves a marker naming what was
  // being done and to what.
  await writeFile(join(transaction, 'promotion.json'), `${JSON.stringify({
    version: 1, project: name, revision, sourceEnvironment: header.sourceEnvironment,
  }, null, 2)}\n`)

  const previousRef = await execFileAsync('git', [`--git-dir=${gitDir}`, 'rev-parse', sourceRef], { encoding: 'utf8' })
    .then(r => r.stdout.trim()).catch(() => null)

  const held = {}
  let refAdvanced = false
  let operationsWritten = false
  try {
    // Objects first, and additively: a fetch adds commits and moves one ref.
    // Nothing is removed, so the destination keeps every revision it has ever
    // been promoted — which is what makes the promotion record durable.
    await execFileAsync('git', [`--git-dir=${gitDir}`, 'fetch', pendingGitDir, `+${sourceRef}:${sourceRef}`], { timeout: 30000 })
    refAdvanced = true
    const landed = (await execFileAsync('git', [`--git-dir=${gitDir}`, 'rev-parse', `${sourceRef}^{commit}`], { encoding: 'utf8' })).stdout.trim()
    if (landed !== revision) throw new Error('promotion ref did not advance to the promoted revision')

    for (const item of PROMOTION_REPLACED_ITEMS) {
      const staged = join(pending, item)
      // Only items the stream actually carried. Swapping an absent item for
      // nothing deletes the live one.
      if (!existsSync(staged)) continue
      held[item] = moveAside(join(destination, item), transaction, item)
      renameSync(staged, join(destination, item))
    }

    // The lifecycle journal, merged rather than replaced.
    const operationsPath = join(destination, '.source-lifecycle', 'operations.json')
    const existing = await readFile(operationsPath, 'utf8').then(JSON.parse).catch(() => ({ version: 1, revisionLifecycle: {} }))
    held['operations.json'] = moveAside(operationsPath, transaction, 'operations.json')
    await writeFile(operationsPath, `${JSON.stringify({
      ...existing,
      version: 1,
      revisionLifecycle: { ...existing.revisionLifecycle, [revision]: header.lifecycle },
    }, null, 2)}\n`)
    operationsWritten = true
  } catch (error) {
    for (const item of Object.keys(held).reverse()) {
      restoreAside(join(destination, item === 'operations.json' ? '.source-lifecycle/operations.json' : item), held[item])
    }
    if (refAdvanced && !operationsWritten) {
      if (previousRef) await execFileAsync('git', [`--git-dir=${gitDir}`, 'update-ref', sourceRef, previousRef]).catch(() => {})
      else await execFileAsync('git', [`--git-dir=${gitDir}`, 'update-ref', '-d', sourceRef]).catch(() => {})
    }
    throw error
  } finally {
    await rm(transaction, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 5. The record — step 4 of the brief, and it is one line of allowlist plus
//    one call.
//
//    `recordRevisionPhase` already stamps `updatedAt`, so the WHEN is free. The
//    phase allowlist in server/lib/source-lifecycle.mjs gains `promotion`:
//
//      if (!['build', 'version', 'mirror', 'promotion'].includes(phase))
//
//    and the destination records, after activation:
//
//      lifecycle.recordRevisionPhase(name, revision, 'promotion', 'promoted', {
//        from: sourceEnvironment, tree,
//      })
//
//    `projectRevisionStatus` reads only `['build', 'version']`, so a promotion
//    phase cannot change any project's reported status.
//
//    What it answers: "when was this project last published, and from where" is
//    the newest `listRevisionLifecycles` row carrying a `promotion` phase. No
//    new store, no journal, no second encoding — and it survives the next
//    promotion because §4 merges the journal instead of replacing it.
//
//    It is deliberately NOT the unreleased indicator's input. The brief already
//    ruled that the indicator compares against the live published surface,
//    because a record can say published while the surface says otherwise. This
//    is for auditability only.
// ---------------------------------------------------------------------------

// ===========================================================================
// APPRAISAL of the draft above, against the intention at the top. Written
// after reading it back, which is the only reason any of this was found.
//
// THREE MECHANICAL DEFECTS, fixable and not interesting:
//
// 1. `held` is keyed by item name, and the rollback then reconstructs each
//    live path from that key — including a hardcoded
//    `.source-lifecycle/operations.json`. That is one fact in two encodings,
//    which is the thing this project pays for most often. `held` should be an
//    array of `{ live, held }` pairs recorded as they are taken.
//
// 2. The rollback guard `refAdvanced && !operationsWritten` reads as though it
//    distinguishes something. It cannot: reaching the catch means the swap did
//    not complete, so `operationsWritten` is always false there. Dead logic
//    wearing the shape of care — always roll the ref back in the catch.
//
// 3. `promotion.json` is a marker with no reader. build-dispatch writes
//    `publication.json` and `recoverBuildPublications` scans for it at
//    startup; nothing scans `.promotion-publish-*`. Writing a marker nobody
//    reads is debris that looks like durability.
//
// ONE REAL GAP, and it is why this draft is not landed:
//
// 4. The swap replaces N items with N renames, so a crash between them leaves
//    the destination missing one item with no recovery pass. That is a WEAKER
//    guarantee than the build publication path this draft claims to reuse —
//    that path has `recoverBuildPublications` behind it. Shipping the weaker
//    one while citing the stronger one as precedent is the shape this
//    repository calls a half-fix.
//
//    The fix that removes the gap rather than patching it: stage the COMPLETE
//    new project directory in `pending` — merged git objects, merged
//    operations.json, and whatever the live project holds that the stream did
//    not carry — then activate with two renames (`destination` aside, `pending`
//    into place). One window for the whole project instead of one per item,
//    and no new recovery pass, because an abandoned `.promotion-*` pending
//    directory is already the create path's failure mode.
//
// WHICH RAISES THE DECISION THAT IS NOT MINE, and is the same one already put
// to the chief:
//
//    Two-rename staging has to decide what a destination project is allowed to
//    LOSE. A promotion stream carries `output`, `build.log`, the source bundle
//    and metadata. It does not carry `build-cache` or `latex.log`, and for a
//    non-qmd format it does not carry `source`. Those either get copied
//    forward from the live project — `build-cache` is the one that can be
//    large — or they get dropped on every publish.
//
//    Dropping them is defensible: a promoted project on `pic` never builds, so
//    they are stale build artifacts of a build that happened somewhere else.
//    But that is a product judgement about what the student box keeps, taken
//    while writing over content students are reading, and §"NOTHING IN THIS
//    APP DELETES ANYTHING" says the default answer is keep.
//
// So this file stops here on purpose. The rig that proves any version of it is
// committed (bin/promotion-crosses-the-wire-test.mjs, 23 stories, two
// counterfactuals); its last story currently asserts the refusal and is the
// story that flips when this lands.
// ===========================================================================
